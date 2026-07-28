"""TRELLIS.2-4B mesh repainting (retexture).

Keeps a mesh you already like and rerolls only the paint. `Trellis2TexturingPipeline`
skips sparse-structure and shape sampling entirely and encodes the mesh you hand it
instead, so the surface comes back the same and the atlas is new.

Everything below is measured in spikes/trellis2 (RETEXTURE-REPORT.md), not assumed:

**The seed ladder has to be much longer here.** The same texture decoder that
collapses on ~5% of seeds when generating collapses on **37.5%** when
retexturing — 3 of 8 seeds on the first mesh tried. Two retries leaves a 5.3%
residual, which is a coin-flip a user would hit within a session, so the catalog
gives this operation a budget of 5. The rate is per-operation data, which is why
it lives in the catalog rather than in either adapter.

**Both collapse modes appear here**, and the white one was FOUND here: seed 2026
returned a pure white atlas while seed 777 returned a black one. That is why
`kind_for_mean` is two-sided.

**The base colour is read from the baked ATLAS, not from PBR attributes.** This
path returns a textured trimesh, not a decoded voxel mesh, so `mesh.attrs` does
not exist. Same decoder and the same [0, 1] scale, so the thresholds carry.

**No inverse transform, and that is a deliberate correction.** `preprocess_mesh`
recenters, rescales and swaps axes, which looked like it would hand every
character back rotated and rescaled — but `postprocess_mesh` inverts the swap at
`trellis2_texturing.py:359` and the spike measured 2.7e-4 mean surface deviation
across seeds. The frame check below stays as a GUARD rather than a correction:
it is cheap, and it is exactly the assumption that would break silently against
a different texturing backend.

**Topology is preserved only if the input carries UVs.** `postprocess_mesh`
reuses `mesh.visual.uv` when present and runs `cumesh.uv_unwrap` when it is not,
which changes the vertex count. Our `raw.glb` carries `TEXCOORD_0`; a mesh from
elsewhere may not, so the meta records what actually happened rather than
assuming. Even on the preserving branch vertices grow ~1.5% from UV-seam
splitting and faces come back reordered: it is the same SURFACE, not the same
BUFFER.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from . import Adapter, AdapterError, Emitter, validate_params
from .trellis2 import (
    GEN_ARTIFACT_MESH,
    GEN_ARTIFACT_META,
    META_FILE,
    RAW_MODEL,
    _ensure_importable,
    _prepare_runtime,
    kind_for_mean,
    reset_vram_stats,
    sample_with_retries,
    vram_peaks,
)

RETEXTURE_ADAPTER_VERSION = "0.1.0"

# How far the output frame may move before we refuse. The spike measured 0.1% of
# extent across seeds, so 2% is far above the noise while still catching the two
# failures worth catching: an un-inverted axis swap (which permutes the per-axis
# extents of any character that is not a cube) and a rescale to the unit box.
#
# HONEST LIMITS, both worth knowing before trusting it. A rescale is only
# visible when the input is not already ~unit sized, so a mesh still in the
# model's own [-0.5, 0.5] space hides it. And the CENTRE term does most of the
# work on the input core actually sends: canonical meshes are grounded at Y=0,
# so a backend that recentred on the bbox and forgot to put it back moves the
# centre by half the height. The number was calibrated against 0.1% of measured
# drift on an origin-centred spike mesh. It is a tripwire for a backend change,
# not a proof of correctness.
FRAME_TOLERANCE = 0.02

PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["meshPath", "imagePath", "outDir", "seed", "modelDir"],
    "properties": {
        "meshPath": {"type": "string", "minLength": 1},
        "imagePath": {"type": "string", "minLength": 1},
        "outDir": {"type": "string", "minLength": 1},
        "modelDir": {"type": "string", "minLength": 1},
        "seed": {"type": "integer", "minimum": 0},
        # 512 costs 3.3 GiB and 16.5 s against 1024's 6.9 GiB and 25 s, and the
        # spike saw no quality advantage to 1024 on the meshes tried
        "resolution": {"type": "integer", "enum": [512, 1024]},
        "textureSize": {"type": "integer", "enum": [1024, 2048, 4096]},
        # catalog data, and 5 here against gen's 2 - see the module docstring
        "textureRetries": {"type": "integer", "minimum": 0, "maximum": 12},
        "lowVram": {"type": "boolean"},
    },
    "additionalProperties": False,
}

DEFAULTS: dict[str, Any] = {
    "resolution": 512,
    "textureSize": 2048,
    "textureRetries": 5,
    "lowVram": True,
}

RETEXTURE_REMEDY = (
    "The input mesh is untouched, so retrying costs only the texture pass. "
    "Generating afresh is the other way through, at the price of new geometry."
)


def as_mesh(loaded: Any) -> Any:
    """A GLB loads as a Scene; take its single geometry.

    Refuses a multi-geometry scene by name rather than silently repainting the
    first part of a character and dropping the rest.
    """
    if hasattr(loaded, "geometry") and not hasattr(loaded, "vertices"):
        geoms = list(loaded.geometry.values())
        if len(geoms) != 1:
            raise AdapterError(
                "bad-input",
                f"expected a single mesh, found {len(geoms)} in the scene. Retexture "
                f"repaints one mesh; split or join the parts first.",
            )
        return geoms[0]
    return loaded


def has_uv(mesh: Any) -> bool:
    return getattr(getattr(mesh, "visual", None), "uv", None) is not None


def frame_shift(before: Any, after: Any) -> float:
    """Largest frame change between two meshes, as a fraction of input extent.

    Compares per-axis extent AND centre, both normalised by the input's largest
    extent, so one number covers a rescale, a translation and an axis swap.
    """
    import numpy as np

    lo_a, hi_a = np.asarray(before.bounds[0]), np.asarray(before.bounds[1])
    lo_b, hi_b = np.asarray(after.bounds[0]), np.asarray(after.bounds[1])
    span = float((hi_a - lo_a).max())
    if span <= 0:
        raise AdapterError("bad-input", "the input mesh has zero extent")
    extent = np.abs((hi_b - lo_b) - (hi_a - lo_a)).max() / span
    centre = np.abs(((hi_b + lo_b) - (hi_a + lo_a)) / 2).max() / span
    return float(max(extent, centre))


def atlas_mean(mesh: Any) -> float:
    """Mean of the baked base-colour atlas, on the same [0, 1] scale as gen.

    A mesh that came back with no base-colour texture at all is a collapse of the
    most complete kind, so it reads as 0.0 rather than raising — the ladder
    should climb past it like any other empty result.
    """
    import numpy as np

    material = getattr(getattr(mesh, "visual", None), "material", None)
    image = getattr(material, "baseColorTexture", None)
    if image is None:
        return 0.0
    return float(np.asarray(image.convert("RGB"), dtype=np.float32).mean() / 255.0)


def _load_mesh(mesh_path: Path) -> Any:
    import trimesh

    if not mesh_path.is_file():
        raise AdapterError("bad-input", f"no mesh to retexture at '{mesh_path}'")
    try:
        loaded = trimesh.load(str(mesh_path), process=False)
    except Exception as err:  # noqa: BLE001 - the message matters more than the type
        raise AdapterError(
            "bad-input", f"cannot read the mesh at '{mesh_path}': {err}"
        ) from err
    return as_mesh(loaded)


def _load_pipeline(model_dir: Path, low_vram: bool) -> Any:
    """Build the texturing pipeline. Module-level so tests can substitute it."""
    os.environ.setdefault("ATTN_BACKEND", "xformers")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    _ensure_importable()
    try:
        from trellis2.pipelines import Trellis2TexturingPipeline
    except ImportError as err:
        raise AdapterError(
            "backend-unavailable",
            f"The trellis2 package is not importable in the sidecar environment: {err}. "
            "Run `uv sync --project sidecar --extra trellis2`.",
        ) from err

    # the texturing pipeline builds the same eager rembg model and uses the same
    # DINOv3 conditioner, so it needs the same two patches before loading
    _prepare_runtime()
    try:
        pipeline = Trellis2TexturingPipeline.from_pretrained(
            str(model_dir), config_file="texturing_pipeline.json"
        )
    except Exception as err:  # noqa: BLE001
        text = str(err)
        if "gated repo" in text or "403" in text or "401" in text:
            raise AdapterError(
                "backend-gated",
                "TRELLIS.2's image conditioner "
                "'facebook/dinov3-vitl16-pretrain-lvd1689m' is a MANUALLY GATED Hugging "
                "Face repo and this machine is not authorised for it. Request access "
                "from Meta on that model's page, then log in with `huggingface-cli "
                "login`.",
            ) from err
        raise AdapterError(
            "backend-failed", f"Loading the TRELLIS.2 texturing pipeline failed: {err}"
        ) from err

    pipeline.low_vram = bool(low_vram)
    pipeline.cuda()
    return pipeline


def retexture_with_retries(
    pipeline: Any,
    mesh: Any,
    image: Any,
    seed: int,
    budget: int,
    resolution: int,
    texture_size: int,
    emit: Emitter,
) -> tuple[Any, int, list[int]]:
    """The shared ladder, wired to the texturing pipeline."""

    def sample(used: int) -> tuple[Any, float]:
        out = pipeline.run(
            mesh,
            image,
            seed=used,
            resolution=int(resolution),
            texture_size=int(texture_size),
            preprocess_image=True,
        )
        return out, atlas_mean(as_mesh(out))

    return sample_with_retries(
        sample, seed, budget, emit, "retexture", RETEXTURE_REMEDY
    )


def run(params: dict[str, Any], emit: Emitter) -> None:
    from .trellis2 import _require_rgba

    p = validate_params(PARAMS_SCHEMA, params, DEFAULTS)
    mesh_path = Path(str(p["meshPath"]))
    out_dir = Path(str(p["outDir"]))
    seed = int(p["seed"])
    budget = int(p["textureRetries"])

    image = _require_rgba(Path(str(p["imagePath"])))
    source = _load_mesh(mesh_path)
    unwrapped = not has_uv(source)
    if unwrapped:
        emit.warn(
            "mesh-unwrapped",
            f"'{mesh_path}' carries no UVs, so the texturing pass will unwrap it and "
            f"the vertex count WILL change. The paint is still valid; anything bound "
            f"to the old vertices - skin weights above all - is not.",
        )
    out_dir.mkdir(parents=True, exist_ok=True)

    # separately timed for the same reason as gen: the load is per process, the
    # work is per character, and the whole argument for a long-lived sidecar
    # lives in the gap between them
    reset_vram_stats()
    load_t0 = time.perf_counter()
    pipeline = _load_pipeline(Path(str(p["modelDir"])), bool(p["lowVram"]))
    load_seconds = round(time.perf_counter() - load_t0, 2)

    run_t0 = time.perf_counter()
    out, used_seed, tried = retexture_with_retries(
        pipeline,
        source,
        image,
        seed,
        budget,
        int(p["resolution"]),
        int(p["textureSize"]),
        emit,
    )
    run_seconds = round(time.perf_counter() - run_t0, 2)
    textured = as_mesh(out)

    # The guard, not a correction. If this trips, the backend changed under us
    # and every character it produced is silently misplaced.
    shift = frame_shift(source, textured)
    if shift > FRAME_TOLERANCE:
        raise AdapterError(
            "frame-moved",
            f"the retextured mesh came back {shift:.1%} out of the input's frame "
            f"(tolerance {FRAME_TOLERANCE:.0%}). TRELLIS.2 normalises the mesh before "
            f"texturing and is expected to invert that on the way out; this output was "
            f"not put back. Refusing rather than writing a character at the wrong size "
            f"or facing the wrong way.",
        )

    out_path = (out_dir / RAW_MODEL).resolve()
    out.export(str(out_path))
    emit.progress("export", budget + 1, budget + 1)

    meta_path = (out_dir / META_FILE).resolve()
    meta_path.write_text(
        json.dumps(
            {
                "adapter": "trellis2-retexture",
                "adapterVersion": RETEXTURE_ADAPTER_VERSION,
                "requestedSeed": seed,
                "effectiveSeed": used_seed,
                "seedsTried": tried,
                "resolution": int(p["resolution"]),
                # what the caller needs to know before trusting an existing rig
                "topologyPreserved": not unwrapped,
                "frameShift": round(shift, 6),
                "loadSeconds": load_seconds,
                "runSeconds": run_seconds,
                **vram_peaks(),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    if used_seed != seed:
        emit.warn(
            "seed-changed",
            f"the requested seed {seed} produced a texture with no content; this was "
            f"painted with seed {used_seed}, which is what the receipt records.",
        )
    emit.artifact(GEN_ARTIFACT_META, str(meta_path))
    emit.artifact(GEN_ARTIFACT_MESH, str(out_path))


ADAPTER = Adapter(
    id="trellis2-retexture",
    kind="retexture",
    version=RETEXTURE_ADAPTER_VERSION,
    params_schema=PARAMS_SCHEMA,
    defaults=DEFAULTS,
    run=run,
)
