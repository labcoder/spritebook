"""TRELLIS.2-4B image-to-3D (gen3d).

Everything unusual in here is a measured finding from spikes/trellis2, not a
precaution. In particular:

**The texture stage collapses on some seeds.** For a given image certain seeds
make the texture decoder emit a CONSTANT — pinned at one end of its [-1, 1]
range — so the base colour carries no content at all while the geometry is
fine. It saturates at EITHER end: black (generation, seed 42, mean 0.0006) or
white (retexture, seed 2026, mean 0.9987). Measured over the 40-run seed
sweep: 2 of 40 on external character art (both at seed 42, on two different
references), 0 on the model's own examples - ~5% per seed. So the
adapter DETECTS it and retries on the next seed rather than shipping a blank
character.

**Detect with the MEAN, not the max.** One failure had `max` 0.9856 from a
handful of stray texels while its mean was 0.0415 and its baked texture was
black. Healthy output spans mean 0.147..0.723 — including a deliberately dark
subject at 0.18 — so 0.10 sits in an empty valley between the populations. A
max-based check passes an unusable character, which is worse than no check.

**Never construct BiRefNet.** `pipeline.preprocess_image()` calls rembg only
when the input has NO alpha. Feeding it the cut-out RGBA our own Apache-2.0
u2net prep already produces means the gated, non-commercially-licensed
`briaai/RMBG-2.0` is never touched. This is why `preprocess_image=True` is
correct and `preprocess_image=False` is not: the latter also skips the
crop-and-premultiply the model expects, and produces markedly worse output.

**`ATTN_BACKEND=xformers` is required**, set before trellis2 is imported. Sparse
attention supports only xformers and flash-attn, with no SDPA fallback, and
flash-attn cannot be installed under the wheels-only law.

**DINOv3 is a manual gate.** `facebook/dinov3-vitl16-pretrain-lvd1689m` is the
image conditioner and cannot be auto-installed; a human must request access from
Meta. We refuse with that sentence rather than letting a 403 surface eighty
seconds into a model load.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import Adapter, AdapterError, Emitter, validate_params

TRELLIS2_ADAPTER_VERSION = "0.1.0"

# A collapsed texture has NO CONTENT, and the decoder can reach that at either
# end of its [-1, 1] range. Black was found first (generation, seed 42, mean
# 0.0006); white turned up in the retexture spike (seed 2026, mean 0.9987) and
# would have sailed past a one-sided check to bake a featureless white
# silhouette. Both bounds are valleys in measured data, not tastes: across the
# generation sweeps healthy output spanned 0.147..0.723, including a
# deliberately dark subject at 0.18 and a bright one at 0.72.
COLLAPSE_MEAN_LOW = 0.10
COLLAPSE_MEAN_HIGH = 0.95

GEN_ARTIFACT_MESH = "mesh-raw"
GEN_ARTIFACT_META = "gen-meta"
RAW_MODEL = "raw.glb"
META_FILE = "gen-meta.json"

PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["imagePath", "outDir", "seed", "modelDir"],
    "properties": {
        "imagePath": {"type": "string", "minLength": 1},
        "outDir": {"type": "string", "minLength": 1},
        "modelDir": {"type": "string", "minLength": 1},
        "seed": {"type": "integer", "minimum": 0},
        # 512 is the default on evidence: it collapsed 2/16 against a mixed
        # shape-1024/texture-512 variant's 5/16, and beat 1024_cascade's texture
        # on every reference tried. 1024_cascade stays available for geometry.
        "pipelineType": {"type": "string", "enum": ["512", "1024", "1024_cascade"]},
        "steps": {"type": "integer", "minimum": 1, "maximum": 50},
        "guidanceStrength": {"type": "number", "minimum": 0, "maximum": 20},
        # loads each model for its stage and offloads after: the reason peak
        # VRAM is ~9 GiB rather than the ~24 the upstream README quotes
        "lowVram": {"type": "boolean"},
        # The BUDGET is catalog data, not a constant here: the collapse rate is a
        # property of the backend and the operation, and it differs by 7x
        # between generating (5% per seed) and retexturing (37.5%). A second
        # backend will bring its own rate, and it should not have to argue with
        # a number compiled into ours.
        "textureRetries": {"type": "integer", "minimum": 0, "maximum": 12},
        "textureSize": {"type": "integer", "enum": [1024, 2048, 4096]},
        # raw output is 3-10 M faces, far past what a sprite bake needs or what
        # UniRig wants to rig
        "decimationTarget": {"type": "integer", "minimum": 10000, "maximum": 2000000},
    },
    "additionalProperties": False,
}

DEFAULTS: dict[str, Any] = {
    "pipelineType": "512",
    "steps": 12,
    "guidanceStrength": 7.5,
    "lowVram": True,
    # the FALLBACK only. The catalog's operationDefaults normally supplies this,
    # per operation, because the collapse rate is not one number.
    "textureRetries": 2,
    "textureSize": 2048,
    "decimationTarget": 200000,
}


def base_color_mean(attrs: Any) -> float:
    """Mean of the base-colour channels of a decoded mesh's PBR attributes.

    `attrs` is (N, 6) with base_color in columns 0..2 (the pipeline's own
    `pbr_attr_layout`). Duck-typed over torch tensors and numpy arrays so the
    detector can be tested without a GPU or a 16 GB model load.
    """
    return float(attrs[:, 0:3].mean())


def kind_for_mean(mean: float) -> str | None:
    """`"black"`, `"white"`, or None when the texture has content.

    Named rather than boolean because the two ends are worth telling apart in a
    warning: a user who sees "white" and a user who sees "black" are looking at
    different-looking characters, and lumping them together makes the message
    describe neither.

    Takes the MEAN rather than a mesh because the two paths reach it
    differently: generation reads decoded PBR attributes, retexture reads a
    baked atlas image. Same decoder, same failure, same [0, 1] scale — so the
    thresholds are shared and there is one place to change them.
    """
    if mean < COLLAPSE_MEAN_LOW:
        return "black"
    if mean > COLLAPSE_MEAN_HIGH:
        return "white"
    return None


def collapse_kind(attrs: Any) -> str | None:
    """`kind_for_mean` for a decoded mesh's PBR attributes (the gen path)."""
    return kind_for_mean(base_color_mean(attrs))


def collapsed(attrs: Any) -> bool:
    """Did the texture decoder collapse, at either end? See the constants."""
    return collapse_kind(attrs) is not None


def _require_rgba(image_path: Path) -> Any:
    from PIL import Image

    try:
        image = Image.open(image_path)
    except Exception as err:  # noqa: BLE001 - the message matters more than the type
        raise AdapterError(
            "bad-input",
            f"Cannot read the source image at '{image_path}': {err}",
        ) from err
    if image.mode != "RGBA":
        raise AdapterError(
            "bad-input",
            f"trellis2 needs a CUT-OUT RGBA image and '{image_path}' is {image.mode}. "
            "Run the prep stage (rembg-u2net) first - its alpha is also what keeps this "
            "backend from reaching for the gated briaai/RMBG-2.0 background remover.",
        )
    return image


def _load_pipeline(model_dir: Path, low_vram: bool) -> Any:
    """Build the TRELLIS.2 pipeline from an installed model directory.

    Module-level so tests can substitute it: everything above this line is pure
    and everything below needs 16 GB of weights and a CUDA device.
    """
    # before importing trellis2: the backend is read at import time
    os.environ.setdefault("ATTN_BACKEND", "xformers")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    try:
        from trellis2.pipelines import Trellis2ImageTo3DPipeline
    except ImportError as err:
        raise AdapterError(
            "backend-unavailable",
            f"The trellis2 package is not importable in the sidecar environment: {err}. "
            "It needs torch 2.8+cu128, xformers, and the five prebuilt CUDA extension "
            "wheels (cumesh, flex_gemm, nvdiffrast, nvdiffrec_render, o_voxel).",
        ) from err

    try:
        pipeline = Trellis2ImageTo3DPipeline.from_pretrained(str(model_dir))
    except Exception as err:  # noqa: BLE001
        text = str(err)
        if "gated repo" in text or "403" in text or "401" in text:
            raise AdapterError(
                "backend-gated",
                "TRELLIS.2's image conditioner "
                "'facebook/dinov3-vitl16-pretrain-lvd1689m' is a MANUALLY GATED Hugging "
                "Face repo and this machine is not authorised for it. Request access from "
                "Meta on that model's page, then log in with `huggingface-cli login`. "
                "It cannot be installed through SpriteBook's registry because the gate is "
                "granted per person, not per download.",
            ) from err
        raise AdapterError("backend-failed", f"Loading TRELLIS.2 failed: {err}") from err

    pipeline.low_vram = bool(low_vram)
    pipeline.cuda()
    return pipeline


def _export_glb(mesh: Any, out_path: Path, texture_size: int, decimation: int) -> None:
    import o_voxel

    mesh.simplify(16777216)  # nvdiffrast's index limit
    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=int(decimation),
        texture_size=int(texture_size),
        remesh=True,
        remesh_band=1,
        remesh_project=0,
        verbose=False,
    )
    glb.export(str(out_path))


GEN_REMEDY = (
    "The geometry is unaffected - a geometry-only run plus the texture substage is "
    "the other way through."
)


def sample_with_retries(
    sample: Callable[[int], tuple[Any, float]],
    seed: int,
    budget: int,
    emit: Emitter,
    step: str,
    remedy: str,
) -> tuple[Any, int, list[int]]:
    """Climb seeds until the texture is not collapsed. -> (result, seed used, tried).

    A deterministic ladder (`seed`, `seed+1`, ...) rather than random retries, so
    a receipt naming the effective seed reproduces exactly. Separated from `run`
    because this is the part worth testing without a GPU.

    `sample(seed) -> (result, mean base colour)` is a callable rather than a
    pipeline because generation and retexture call different pipelines with
    different signatures and read the base colour from different places — but it
    is ONE decoder failing ONE way, so it deserves one ladder, one warning shape
    and one refusal rather than two that drift.
    """
    tried: list[int] = []
    for attempt in range(budget + 1):
        used = seed + attempt
        emit.progress(f"{step}:seed{used}", attempt + 1, budget + 1)
        result, mean = sample(used)
        tried.append(used)
        kind = kind_for_mean(mean)
        if kind is None:
            return result, used, tried
        emit.warn(
            "texture-collapsed",
            f"seed {used} produced a {kind} texture with no content (mean base colour "
            f"{mean:.4f}) - a known TRELLIS.2 failure that depends on the image, the "
            f"mesh and the seed together, not on the seed alone. Retrying on seed "
            f"{used + 1}.",
        )

    # Every seed collapsed. Shipping a blank character silently is the one thing
    # this ladder exists to prevent, so this is a refusal, not a fallback.
    raise AdapterError(
        "texture-collapsed",
        f"all {budget + 1} seeds ({', '.join(map(str, tried))}) produced a texture "
        f"with no content. Re-run with a different --seed, or raise textureRetries. "
        f"{remedy}",
        True,
    )


def generate_with_retries(
    pipeline: Any,
    image: Any,
    seed: int,
    budget: int,
    pipeline_type: str,
    emit: Emitter,
) -> tuple[Any, int, list[int]]:
    """The ladder, wired to the image-to-3D pipeline."""

    def sample(used: int) -> tuple[Any, float]:
        mesh = pipeline.run(
            image, seed=used, pipeline_type=pipeline_type, preprocess_image=True
        )[0]
        return mesh, base_color_mean(mesh.attrs)

    return sample_with_retries(sample, seed, budget, emit, "generate", GEN_REMEDY)


def run(params: dict[str, Any], emit: Emitter) -> None:
    p = validate_params(PARAMS_SCHEMA, params, DEFAULTS)
    image_path = Path(str(p["imagePath"]))
    out_dir = Path(str(p["outDir"]))
    model_dir = Path(str(p["modelDir"]))
    seed = int(p["seed"])
    budget = int(p["textureRetries"])

    image = _require_rgba(image_path)
    out_dir.mkdir(parents=True, exist_ok=True)

    pipeline = _load_pipeline(model_dir, bool(p["lowVram"]))
    mesh, used_seed, tried = generate_with_retries(
        pipeline, image, seed, budget, str(p["pipelineType"]), emit
    )

    out_path = (out_dir / RAW_MODEL).resolve()
    _export_glb(mesh, out_path, int(p["textureSize"]), int(p["decimationTarget"]))
    emit.progress("encode", budget + 1, budget + 1)

    # The seed that WORKED, written where core can read it. Recording the
    # requested seed instead would make "re-run exactly this" reproduce the
    # failure rather than the result.
    meta_path = (out_dir / META_FILE).resolve()
    meta_path.write_text(
        json.dumps(
            {
                "adapter": "trellis2",
                "adapterVersion": TRELLIS2_ADAPTER_VERSION,
                "requestedSeed": seed,
                "effectiveSeed": used_seed,
                "seedsTried": tried,
                "pipelineType": str(p["pipelineType"]),
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
            f"generated with seed {used_seed}, which is what the receipt records.",
        )
    emit.artifact(GEN_ARTIFACT_META, str(meta_path))
    emit.artifact(GEN_ARTIFACT_MESH, str(out_path))


ADAPTER = Adapter(
    id="trellis2",
    kind="gen3d",
    version=TRELLIS2_ADAPTER_VERSION,
    params_schema=PARAMS_SCHEMA,
    defaults=DEFAULTS,
    run=run,
    description=(
        "TRELLIS.2-4B image-to-3D (MIT weights). Takes a cut-out RGBA image and returns a "
        "textured glb with PBR attributes. Detects the seed-dependent texture collapse and "
        "retries on the next seed; records the seed that actually worked. Needs a manually "
        "gated DINOv3 conditioner and ~9 GiB of VRAM."
    ),
)
