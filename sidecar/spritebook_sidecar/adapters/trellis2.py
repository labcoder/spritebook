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

**Never construct BiRefNet — and it takes a patch, not just good manners.**
This used to say the gated `briaai/RMBG-2.0` was never touched because
`preprocess_image()` only calls rembg when the input has no alpha, which is
true of the CALL and false of the CONSTRUCTION. `from_pretrained` builds the
rembg model eagerly while loading the pipeline
(`trellis2_image_to_3d.py:105`), and `BiRefNet.__init__` immediately runs
`AutoModelForImageSegmentation.from_pretrained('briaai/RMBG-2.0',
trust_remote_code=True)` — a gated download AND arbitrary code from the hub,
before anyone has passed an image. `_stub_rembg` replaces the class before the
load so neither happens. Feeding cut-out RGBA is still right for a second
reason: `preprocess_image=False` skips the crop-and-premultiply the model
expects and produces markedly worse output.

**`ATTN_BACKEND=xformers` is required**, set before trellis2 is imported. Sparse
attention supports only xformers and flash-attn, with no SDPA fallback, and
flash-attn cannot be installed under the wheels-only law.

**DINOv3 is a manual gate.** `facebook/dinov3-vitl16-pretrain-lvd1689m` is the
image conditioner and cannot be auto-installed; a human must request access from
Meta. We refuse with that sentence rather than letting a 403 surface eighty
seconds into a model load.

**transformers 5.x moved the DINOv3 encoder blocks** from `model.layer` to
`model.model.layer`, and TRELLIS.2 reaches for the old path. `_shim_dinov3`
rewrites `extract_features` to accept either layout. The pin
(`transformers==5.14.1`, sidecar's `trellis2` extra) is what makes this a known
pair rather than a moving target.

**The `trellis2` package is imported from a CHECKOUT, not installed.** Upstream
ships no packaging metadata, so there is no wheel and `uv` cannot manage it. See
`_code_dir`.
"""

from __future__ import annotations

import json
import os
import time
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

# A SECOND failure the base-colour check cannot see: the model decides the whole
# character is made of metal. Measured on bulma, 68% of runs came back majority
# metal, against 1.7% of texels for TRELLIS.2's own flower example — and 9 of 22
# of them had a perfectly healthy base colour, so they sailed through the
# collapse check. In a metal workflow base colour is specular reflectance and
# there is no diffuse albedo at all, which is why those characters read as
# washed-out chrome in any PBR viewer.
#
# The threshold is the FRACTION of lit texels above 0.5, not the mean, and it is
# set high on purpose. Observed failures cluster at 85-100% while good runs sit
# at 0-1.7%, so the empty valley is enormous and almost any cut works on this
# evidence. 0.60 is chosen for a case the evidence does NOT contain: a character
# in plate armour is legitimately part metal, and no real character — face,
# hair, leather, cloth — is 60% of its surface. The one observed failure below
# this line (31% metal) had a base colour of 0.044 and is caught as a collapse.
METAL_TEXEL_FRACTION = 0.60

GEN_ARTIFACT_MESH = "mesh-raw"
#: candidate i's base seed is seed + i * SEED_STRIDE - a cross-adapter
#: convention, wide enough that the collapse-retry ladder (+1 steps) can never
#: walk one candidate into another's seed range
SEED_STRIDE = 1000
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
        # drives SHAPE (sparse structure + shape SLat). Declared but never passed
        # until the guidance sweep needed the texture equivalent and found it dead.
        "guidanceStrength": {"type": "number", "minimum": 0, "maximum": 20},
        # drives the TEXTURE sampler, which upstream ships at 1.0 - a value the
        # CFG mixin short-circuits to no guidance at all. See generate_with_retries
        # for why generation keeps that default and retexture does not.
        "textureGuidance": {"type": "number", "minimum": 1, "maximum": 20},
        # upstream `guidance_rescale` for the texture sampler (ships 0.0).
        # Deployments running guided texturing pair strength ~2-3 with rescale
        # 0.1-0.3 to damp CFG artifacts; ours was never plumbed, so every
        # recorded run implicitly carried 0.0. Exposed for the A1 sweep
        # (spikes/trellis2/QUALITY-AUDIT.md); moot while textureGuidance is 1.
        "textureGuidanceRescale": {"type": "number", "minimum": 0, "maximum": 1},
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
        # B2 (QUALITY-AUDIT.md): N candidates in ONE job, so the ~90 s model
        # load is paid once. Ranked core-side; every candidate becomes a receipt.
        "candidates": {"type": "integer", "minimum": 1, "maximum": 8},
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
    "textureGuidance": 1.0,
    "textureGuidanceRescale": 0.0,
    "lowVram": True,
    # the FALLBACK only. The catalog's operationDefaults normally supplies this,
    # per operation, because the collapse rate is not one number.
    "textureRetries": 2,
    "textureSize": 2048,
    "decimationTarget": 200000,
    "candidates": 1,
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


def metal_fraction(metallic: Any) -> float:
    """Fraction of a metallic channel above 0.5, on any [0, 1] array.

    `.detach().cpu()` first because the generation path hands this a torch
    tensor living on the GPU, and `np.asarray` on one raises "can't convert
    cuda:0 device type tensor to numpy" — which is exactly how this shipped
    broken: `base_color_mean` beside it is duck-typed and survives a CUDA
    tensor, the retexture path reads PIL images, and the test fakes are numpy,
    so nothing in the suite ever handed this a GPU tensor.
    """
    import numpy as np

    if hasattr(metallic, "detach"):  # a torch tensor, possibly on CUDA
        metallic = metallic.detach().cpu()
    a = np.asarray(metallic, dtype=np.float32)
    return 0.0 if a.size == 0 else float((a > 0.5).mean())


def metal_fraction_from_attrs(attrs: Any) -> float:
    """The gen path's metallic: column 3 of the decoded PBR attributes."""
    return metal_fraction(attrs[:, 3])


def quality_fault(mean: float, metal: float) -> str | None:
    """The whole verdict on one sampled texture, or None when it is usable.

    Two INDEPENDENT failures — measured correlation between them is +0.06, so
    neither implies the other and a gate that checks one passes half of what it
    should. Base colour is checked first only because it is the cheaper signal;
    the order carries no meaning beyond which sentence the user reads.
    """
    kind = kind_for_mean(mean)
    if kind is not None:
        return f"a {kind} texture with no content (mean base colour {mean:.4f})"
    if metal > METAL_TEXEL_FRACTION:
        return (
            f"an all-metal material ({metal:.0%} of the surface), which has no diffuse "
            f"colour at all and renders as chrome"
        )
    return None


def collapsed(attrs: Any) -> bool:
    """Did the texture decoder collapse, at either end? See the constants."""
    return collapse_kind(attrs) is not None


CODE_DIR_ENV = "SPRITEBOOK_TRELLIS2_CODE"


def _code_dir() -> Path:
    """Where the `trellis2` SOURCE lives, since it cannot be installed.

    Upstream ships no packaging metadata — no `pyproject.toml`, no `setup.py` —
    so the extra installs the dependencies and this finds the package itself.
    `SPRITEBOOK_TRELLIS2_CODE` wins; otherwise the repo's own checkout path.

    INTERIM. The registry manages weights by hash and should manage backend code
    the same way; until it does, this is a documented path rather than a
    surprise. Nothing else in the sidecar reaches outside its own directory.
    """
    override = os.environ.get(CODE_DIR_ENV)
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[2] / ".deps" / "trellis2"


def _ensure_importable() -> None:
    """Put the checkout on `sys.path`, unless trellis2 is already importable.

    The short-circuit matters: a future packaged trellis2 must win over a stale
    checkout sitting beside it, not lose to one.
    """
    import importlib.util
    import sys

    # Set HERE, not at the call site: `trellis2.modules.sparse` reads
    # ATTN_BACKEND at IMPORT time and defaults to flash_attn, which cannot be
    # installed under the wheels-only law. Anything that imports trellis2
    # without going through `_load_pipeline` — a spike script, a future
    # adapter — otherwise dies with `No module named 'flash_attn'` deep inside
    # an attention forward, minutes into a run.
    os.environ.setdefault("ATTN_BACKEND", "xformers")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    if importlib.util.find_spec("trellis2") is not None:
        return
    code = _code_dir()
    if not (code / "trellis2").is_dir():
        raise AdapterError(
            "backend-unavailable",
            f"The TRELLIS.2 source is not at '{code}'. It ships no packaging metadata, so it is "
            f"used from a checkout: `git clone --depth 1 "
            f"https://github.com/microsoft/TRELLIS.2.git {code}`, or set {CODE_DIR_ENV} to where "
            f"it already is. The Python dependencies are separate: "
            f"`uv sync --project sidecar --extra trellis2`.",
        )
    if str(code) not in sys.path:
        sys.path.insert(0, str(code))


class _RefusedRembg:
    """Stands in for BiRefNet so the gated model is never built, or run.

    Construction is a no-op; a CALL is a refusal rather than a silent pass,
    because reaching it would mean an image arrived without alpha and the answer
    is to run our own prep, not to quietly fetch someone else's matting model.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    def to(self, device: str) -> "_RefusedRembg":
        return self

    def cuda(self) -> "_RefusedRembg":
        return self

    def cpu(self) -> "_RefusedRembg":
        return self

    def __call__(self, image: Any) -> Any:
        raise AdapterError(
            "bad-input",
            "TRELLIS.2 tried to remove the background itself, which means the image reached it "
            "without alpha. SpriteBook does its own cut-out (rembg-u2net, Apache-2.0); the "
            "backend's matting model is briaai/RMBG-2.0, which is gated, non-commercial, and "
            "loads remote code. Run `spritebook prep` on the source image first.",
        )


def _stub_rembg() -> None:
    """Replace BiRefNet BEFORE `from_pretrained`. See the module docstring.

    `trellis2.pipelines.rembg` star-exports the class, and both pipelines reach
    it with `getattr(rembg, args['rembg_model']['name'])`, so replacing the one
    module attribute covers both.
    """
    from trellis2.pipelines import rembg as rembg_mod

    rembg_mod.BiRefNet = _RefusedRembg


def _shim_dinov3() -> None:
    """Teach `extract_features` about the transformers-5 block move.

    Reads `model.layer` when it exists and `model.model.layer` when it does not,
    so this works against either layout rather than trading one hard-coded path
    for another.
    """
    import torch.nn.functional as F

    from trellis2.modules import image_feature_extractor as ife

    def extract_features(self: Any, image: Any) -> Any:
        image = image.to(self.model.embeddings.patch_embeddings.weight.dtype)
        h = self.model.embeddings(image, bool_masked_pos=None)
        pos = self.model.rope_embeddings(image)
        blocks = getattr(self.model, "layer", None)
        if blocks is None:
            blocks = self.model.model.layer
        for blk in blocks:
            h = blk(h, position_embeddings=pos)
        return F.layer_norm(h, h.shape[-1:])

    ife.DinoV3FeatureExtractor.extract_features = extract_features


def _prepare_runtime() -> None:
    """Everything that must happen between importing trellis2 and loading it."""
    _stub_rembg()
    _shim_dinov3()


def reset_vram_stats() -> None:
    """Zero torch's peak counters, if there is a CUDA device to zero them on."""
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except Exception:  # noqa: BLE001 - measurement must never fail a good run
        pass


def vram_peaks() -> dict[str, float]:
    """Peak VRAM since the last reset, in GiB. Empty when there is no CUDA.

    RESERVED is the number that matters for "will this fit": it is what the
    caching allocator took from the driver, and it is what another process sees
    missing. ALLOCATED is what the tensors actually used, and the gap between
    them is fragmentation. Reporting only one of them has misled us before -
    the first VRAM probe understated the real peak 3x.
    """
    try:
        import torch

        if not torch.cuda.is_available():
            return {}
        torch.cuda.synchronize()
        gib = 1024**3
        return {
            "peakVramReservedGb": round(torch.cuda.max_memory_reserved() / gib, 2),
            "peakVramAllocatedGb": round(torch.cuda.max_memory_allocated() / gib, 2),
        }
    except Exception:  # noqa: BLE001
        return {}


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
    _ensure_importable()  # also sets ATTN_BACKEND, which is read at import time
    try:
        from trellis2.pipelines import Trellis2ImageTo3DPipeline
    except ImportError as err:
        raise AdapterError(
            "backend-unavailable",
            f"The trellis2 package is not importable in the sidecar environment: {err}. "
            "Its dependencies are an optional extra - `uv sync --project sidecar --extra "
            "trellis2` installs torch 2.8+cu128, xformers, and the five prebuilt CUDA "
            "extension wheels (cumesh, flex_gemm, nvdiffrast, nvdiffrec_render, o_voxel).",
        ) from err

    _prepare_runtime()
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
                "Meta on that model's page, then log in with `hf auth login`. "
                "Access approval is manual; the conditioner is not yet declared in "
                "SpriteBook's registry.",
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
    sample: Callable[[int], tuple[Any, str | None]],
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

    `sample(seed) -> (result, fault or None)` is a callable rather than a
    pipeline because generation and retexture call different pipelines with
    different signatures and read the material from different places — but it is
    ONE decoder failing, so it deserves one ladder, one warning shape and one
    refusal rather than two that drift. The FAULT is a sentence, not a code:
    the sampler knows which check failed and by how much, and the ladder only
    needs to repeat it.
    """
    tried: list[int] = []
    faults: list[str] = []
    for attempt in range(budget + 1):
        used = seed + attempt
        emit.progress(f"{step}:seed{used}", attempt + 1, budget + 1)
        result, fault = sample(used)
        tried.append(used)
        if fault is None:
            return result, used, tried
        faults.append(f"seed {used}: {fault}")
        emit.warn(
            "texture-rejected",
            f"seed {used} produced {fault} - a known TRELLIS.2 failure that depends on "
            f"the image, the mesh and the seed together, not on the seed alone. "
            f"Retrying on seed {used + 1}.",
        )

    # Every seed failed. Shipping a blank or chrome character silently is the one
    # thing this ladder exists to prevent, so this is a refusal, not a fallback.
    raise AdapterError(
        "texture-rejected",
        f"all {budget + 1} seeds produced unusable material - {'; '.join(faults)}. "
        f"Re-run with a different --seed, or raise textureRetries. {remedy}",
        True,
    )


def generate_with_retries(
    pipeline: Any,
    image: Any,
    seed: int,
    budget: int,
    pipeline_type: str,
    emit: Emitter,
    steps: int = 12,
    guidance: float = 7.5,
    texture_guidance: float = 1.0,
    texture_guidance_rescale: float = 0.0,
) -> tuple[Any, int, list[int]]:
    """The ladder, wired to the image-to-3D pipeline.

    `steps` and `guidance` drive the SHAPE — sparse structure and shape SLat,
    the two stages that decide what the character looks like. They were declared
    in the params schema, validated, and recorded in the receipt without ever
    reaching the pipeline, so `--adjust guidanceStrength=12` was accepted and did
    nothing; they are passed now.

    `texture_guidance` is separate because the texture sampler is separate, and
    upstream ships it at 1.0 — which the CFG mixin short-circuits to "no guidance
    at all". It stays at that default HERE: the sweep that justifies raising it
    was run on the retexture path, and generation already produces faithful
    colour on the one subject measured (saturation 0.293 against a source 0.326).
    Changing an unswept default on the strength of a different path's evidence is
    the mistake this file has made before.
    """

    def sample(used: int) -> tuple[Any, str | None]:
        mesh = pipeline.run(
            image,
            seed=used,
            pipeline_type=pipeline_type,
            preprocess_image=True,
            sparse_structure_sampler_params={
                "steps": int(steps),
                "guidance_strength": float(guidance),
            },
            shape_slat_sampler_params={
                "steps": int(steps),
                "guidance_strength": float(guidance),
            },
            tex_slat_sampler_params={
                "guidance_strength": float(texture_guidance),
                "guidance_rescale": float(texture_guidance_rescale),
            },
        )[0]
        return mesh, quality_fault(
            base_color_mean(mesh.attrs), metal_fraction_from_attrs(mesh.attrs)
        )

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

    # Load and work are timed SEPARATELY because they scale differently: the
    # load is ~100 s of reading 16 GB off disk and is paid once per process,
    # while the work is per character. Reporting one total would make a
    # long-lived sidecar look no cheaper than a fresh one per job.
    reset_vram_stats()
    load_t0 = time.perf_counter()
    pipeline = _load_pipeline(model_dir, bool(p["lowVram"]))
    load_seconds = round(time.perf_counter() - load_t0, 2)

    candidates = int(p["candidates"])
    entries: list[dict[str, Any]] = []
    out_paths: list[Path] = []
    for c in range(candidates):
        base_seed = seed + c * SEED_STRIDE
        run_t0 = time.perf_counter()
        mesh, used_seed, tried = generate_with_retries(
            pipeline,
            image,
            base_seed,
            budget,
            str(p["pipelineType"]),
            emit,
            steps=int(p["steps"]),
            guidance=float(p["guidanceStrength"]),
            texture_guidance=float(p["textureGuidance"]),
            texture_guidance_rescale=float(p["textureGuidanceRescale"]),
        )
        run_seconds = round(time.perf_counter() - run_t0, 2)

        # candidate 0 keeps the historical name so a 1-candidate run is
        # byte-for-byte the old contract
        name = RAW_MODEL if c == 0 else f"raw-{c}.glb"
        out_path = (out_dir / name).resolve()
        _export_glb(mesh, out_path, int(p["textureSize"]), int(p["decimationTarget"]))
        emit.progress(f"encode:{c + 1}/{candidates}", c + 1, candidates)

        if used_seed != base_seed:
            emit.warn(
                "seed-changed",
                f"candidate {c}: the requested seed {base_seed} produced material the "
                f"quality gate rejected; this one was generated with seed {used_seed}, "
                f"which is what the receipt records.",
            )
        entries.append(
            {
                "index": c,
                "requestedSeed": base_seed,
                "effectiveSeed": used_seed,
                "seedsTried": tried,
                "runSeconds": run_seconds,
            }
        )
        out_paths.append(out_path)
        del mesh

    # The seeds that WORKED, written where core can read them. Recording the
    # requested seeds instead would make "re-run exactly this" reproduce the
    # failure rather than the result. The legacy top-level fields mirror
    # candidate 0, so a 1-candidate gen-meta is byte-compatible with the
    # pre-candidates format and old readers keep working.
    meta_path = (out_dir / META_FILE).resolve()
    meta_path.write_text(
        json.dumps(
            {
                "adapter": "trellis2",
                "adapterVersion": TRELLIS2_ADAPTER_VERSION,
                "requestedSeed": entries[0]["requestedSeed"],
                "effectiveSeed": entries[0]["effectiveSeed"],
                "seedsTried": entries[0]["seedsTried"],
                "candidates": entries,
                "pipelineType": str(p["pipelineType"]),
                "loadSeconds": load_seconds,
                "runSeconds": round(sum(e["runSeconds"] for e in entries), 2),
                **vram_peaks(),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    emit.artifact(GEN_ARTIFACT_META, str(meta_path))
    # one mesh-raw per candidate, in INDEX ORDER - core pairs them positionally
    for out_path in out_paths:
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
