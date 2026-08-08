"""UniRig auto-rig adapter (kind ``rig``) — the Track B generic rigger.

Contracts: ``packages/schema/rig.ts`` (FROZEN). The adapter writes
``rig.json`` (RigSkeleton) and ``rig.npz`` (per-vertex influences) into
``outDir`` and emits them as ``rig-skeleton`` / ``rig-weights``. It NEVER writes
a rigged glb: applying the rig is core's job, and that data seam is where the
GPL boundary is drawn (bpy is upstream's exporter, not ours).

## Why every stage is a subprocess

The sidecar's own environment is deliberately light — no torch, no bpy, and it
must stay that way so ``/handshake`` is instant on a machine with no GPU. The
UniRig stack (torch 2.7+cu128, flash-attn, spconv, bpy 4.2, ~9 GB) lives in its
OWN uv environment, and this adapter drives it with explicit argument lists.
That also buys the process discipline the sidecar-vram skill demands for free:
bpy stages routinely crash 0xC0000005 at interpreter teardown AFTER writing
their output, so every stage here is validated by ITS ARTIFACTS and its exit
code is only ever reported, never trusted.

Configure the environment with (all optional; the defaults are repo-relative):

    SPRITEBOOK_UNIRIG_HOME     the UniRig clone            spikes/autorig/UniRig
    SPRITEBOOK_UNIRIG_PYTHON   the interpreter to drive    spikes/autorig/.venv/...
    SPRITEBOOK_UNIRIG_KEEP     '1' keeps the scratch dir of a successful run

A missing environment is an actionable ``backend-missing`` error naming both the
path it looked at and the variable that overrides it.

## Where the weights come from

The registry is the source of truth for weights (D-009): core installs them and
passes ``modelDir``. UniRig's ``src/inference/download.py`` maps three KNOWN
relative checkpoint strings onto ``hf_hub_download`` and returns anything else
UNCHANGED — so writing the ABSOLUTE path of the installed checkpoint into a
generated task config takes the HF path out of the picture entirely, with no
upstream patch. ``HF_HUB_OFFLINE=1`` is set on every stage as a second lock: an
adapter that silently re-downloads a 5.8 GB checkpoint it was handed is a bug,
and this way it cannot.

The one thing the registry does NOT ship is the ``facebook/opt-350m`` ARCHITECTURE
config (a few KB of JSON that ``AutoConfig.from_pretrained`` resolves to build
the AR model — no weights are fetched, they come from the checkpoint). If
``<modelDir>/opt-350m/config.json`` exists it is used; otherwise the adapter
falls back to the local HF cache, warns, and refuses to run if the cache does
not have it either.

## Upstream configuration this adapter supplies

Both task configs are GENERATED per job into the scratch dir, so a pristine
UniRig clone works unmodified:

- ``resume_from_checkpoint`` -> the absolute path under ``modelDir``;
- the skin model gets ``enable_flash: False`` (+ upcast attention/softmax) — the
  P0-T4 find: flash-attn 2.8.3's varlen kernel commits an illegal memory access
  on Windows sm_86 inside PTv3, giving 100% NaN skin weights under bf16 with a
  clean exit code. Correctness costs +7.4 GiB of peak VRAM, and that trade is
  part of this adapter's VRAM contract;
- torch >= 2.6 rejects the skin checkpoint's embedded ``box.Box`` under the safe
  unpickler; ``unirig_stage.py`` re-enables the full unpickler IN PROCESS. The
  trust anchor is the registry's pinned sha256, never the loader flag.

## Output validation (the law)

Nothing is emitted before: a NaN/Inf census over the predicted weights AND joint
positions; per-vertex row sums (unnormalized counted, then renormalized, with
zero-weight rows GUARDED rather than divided by zero); joint-index bounds; and
topological parent order (reordered if upstream did not deliver it). A failed
census retries ONCE on ``seed + 1`` (tier-1 auto-repair) before surfacing
``invalid-output`` with the numbers. Every count lands in the ``validation``
block of ``rig.json`` — including ``retries``, so a rig that needed a second try
says so forever.

## rig.npz layout

    joints    (N, 4) int32   joint index per influence slot
    weights   (N, 4) float32 rows sum to 1, or to 0 for a zero-weight vertex
    primitives(K, 5) int32   node, mesh, primitive, firstVertex, vertexCount

The first array is named ``joints`` because packages/schema/rig.ts froze that
name and core reads it — the merge stage calls the same thing ``indices``
internally only because ITS npz also carries joint POSITIONS under ``joints``;
that collision does not exist here, where positions live in ``rig.json``.

``N`` is the vertex count of the input glb's DEFAULT SCENE, flattened in the
order ``read_scene_geometry`` documents (scene node order, depth first,
primitives in order, node world matrices applied). ``primitives`` records each
span so a consumer can prove its own traversal agrees instead of assuming it.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from . import Adapter, AdapterError, Emitter, validate_params
from ..glb import read_scene_geometry
from .unirig_humanoid_ref import HUMANOID_REFERENCE, HUMANOID_REFERENCE_SOURCE

UNIRIG_ADAPTER_VERSION = "1.0.0"

# --- mirrors packages/schema/rig.ts (FROZEN) ----------------------------------
RIG_SKELETON_FILE = "rig.json"
RIG_WEIGHTS_FILE = "rig.npz"
RIG_ARTIFACT_SKELETON = "rig-skeleton"
RIG_ARTIFACT_WEIGHTS = "rig-weights"
RIG_SCHEMA_VERSION = 1
#: glTF's JOINTS_0 holds four influences; RigSkeleton.influencesPerVertex says so
INFLUENCES_PER_VERTEX = 4

# --- environment --------------------------------------------------------------
ENV_HOME = "SPRITEBOOK_UNIRIG_HOME"
ENV_PYTHON = "SPRITEBOOK_UNIRIG_PYTHON"
ENV_KEEP = "SPRITEBOOK_UNIRIG_KEEP"
#: repo-relative defaults (this file is sidecar/spritebook_sidecar/adapters/)
DEFAULT_HOME = Path("spikes") / "autorig" / "UniRig"
DEFAULT_PYTHON = Path("spikes") / "autorig" / ".venv" / "Scripts" / "python.exe"
DEFAULT_PYTHON_POSIX = Path("spikes") / "autorig" / ".venv" / "bin" / "python"

#: checkpoint layout inside modelDir — the registry catalog's `files[].path`
SKELETON_CKPT = Path("skeleton") / "articulation-xl_quantization_256" / "model.ckpt"
SKIN_CKPT = Path("skin") / "articulation-xl" / "model.ckpt"

#: upstream task configs this adapter specializes
SKELETON_TASK = "configs/task/quick_inference_skeleton_articulationxl_ar_256.yaml"
SKIN_TASK = "configs/task/quick_inference_unirig_skin.yaml"
SKIN_MODEL = "configs/model/unirig_skin.yaml"
AR_MODEL = "configs/model/unirig_ar_350m_1024_81920_float32.yaml"
DATA_CONFIG = "configs/data/quick_inference.yaml"
REQUIRE_SUFFIX = "obj,fbx,FBX,dae,glb,gltf,vrm"
#: UniRig's own quick-inference decimation target
FACES_TARGET = 50000

#: per-stage wall clock ceiling. P0-T4 measured 75-85 s END TO END; a stage that
#: has burned ten times the whole budget is wedged, not slow.
STAGE_TIMEOUT_S = 900.0

# --- validator tuning ---------------------------------------------------------
#: how far a per-vertex weight row may stray from 1 before it counts as
#: unnormalized. UniRig's own output sits within ~1e-6; 1e-3 is float slack.
ROW_SUM_TOLERANCE = 1e-3
#: unit-height distance at which a predicted joint may take a reference name
#: (the value spikes/autorig/tools/rename-bones.py settled on)
NAME_MATCH_THRESHOLD = 0.12
#: the mirrored hypothesis must beat the direct one by this much before it is
#: believed — on a near-symmetric character the two tie on float noise and a
#: wrong call silently swaps left and right (P0-T4 catalog item 6)
NAME_MIRROR_MARGIN = 0.005
#: fraction of joints that must take a reference name before the skeleton is
#: called semantically named
SEMANTIC_MIN_FRACTION = 0.5
#: reference joints the retarget cannot run without (the UAL core, minus the
#: `root` UniRig never predicts). The greedy global threshold can name twenty
#: finger tips and leave the pelvis or a hand as ``bone_N`` (UX pass 2, kira:
#: both hands and a clavicle lost to fingers; pelvis borderline run-to-run),
#: and no downstream alias can name an unnamed joint — so these get a second
#: chance under a looser, still-bounded radius. D-040.
CORE_RESCUE_NAMES = (
    "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head",
    "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l",
    "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r",
    "thigh_l", "calf_l", "foot_l", "thigh_r", "calf_r", "foot_r",
)
#: rescue radius: twice the strict threshold, in the same unit-height space
CORE_RESCUE_THRESHOLD = 2.0 * NAME_MATCH_THRESHOLD

PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["meshPath", "outDir", "seed", "modelDir"],
    "properties": {
        "meshPath": {"type": "string", "minLength": 1},
        "outDir": {"type": "string", "minLength": 1},
        "seed": {"type": "integer", "minimum": 0},
        "modelDir": {"type": "string", "minLength": 1},
        "hints": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["joint", "position"],
                "properties": {
                    "joint": {"type": "string", "minLength": 1},
                    "position": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 3,
                        "maxItems": 3,
                    },
                },
                "additionalProperties": False,
            },
        },
    },
    "additionalProperties": False,
}

DEFAULTS: dict[str, Any] = {"seed": 42}


# --- environment discovery ----------------------------------------------------


def _repo_root() -> Path:
    """sidecar/spritebook_sidecar/adapters/unirig.py -> the repo root."""
    return Path(__file__).resolve().parents[3]


def unirig_home() -> Path:
    override = os.environ.get(ENV_HOME)
    return Path(override) if override else _repo_root() / DEFAULT_HOME


def unirig_python() -> Path:
    override = os.environ.get(ENV_PYTHON)
    if override:
        return Path(override)
    root = _repo_root()
    win = root / DEFAULT_PYTHON
    return win if win.is_file() else root / DEFAULT_PYTHON_POSIX


def resolve_backend(home: Path, python: Path) -> None:
    """Refuse EARLY, with the path and the override, when the env is absent."""
    if not (home / "run.py").is_file():
        raise AdapterError(
            "backend-missing",
            f"UniRig is not installed at '{home}' (no run.py). Clone "
            "https://github.com/VAST-AI-Research/UniRig there, or point "
            f"{ENV_HOME} at an existing clone.",
            False,
        )
    if not (home / SKIN_TASK).is_file():
        raise AdapterError(
            "backend-missing",
            f"'{home}' does not look like a UniRig checkout: {SKIN_TASK} is missing.",
            False,
        )
    if not python.is_file():
        raise AdapterError(
            "backend-missing",
            f"The UniRig Python environment is not installed at '{python}'. Create it with the "
            "recipe in spikes/autorig/README.md (uv, prebuilt wheels only), or point "
            f"{ENV_PYTHON} at an existing interpreter. The sidecar's own environment "
            "deliberately has no torch and cannot run UniRig in-process.",
            False,
        )


def resolve_checkpoints(model_dir: Path) -> tuple[Path, Path]:
    """The two installed checkpoints, or an actionable ``model-missing``."""
    skeleton = (model_dir / SKELETON_CKPT).resolve()
    skin = (model_dir / SKIN_CKPT).resolve()
    missing = [str(p) for p in (skeleton, skin) if not p.is_file()]
    if missing:
        raise AdapterError(
            "model-missing",
            "UniRig checkpoint(s) not found: " + "; ".join(missing) + ". "
            "Run `spritebook models install unirig` to install them.",
            False,
        )
    return skeleton, skin


def backend_version(model_dir: Path) -> str:
    """What produced this rig, for RigSkeleton.backend.

    The install receipt is authoritative (it carries the registry version the
    hashes were verified against); the directory name is the fallback because
    core names the install dir after that same version.
    """
    receipt = model_dir / "receipt.json"
    if receipt.is_file():
        try:
            data = json.loads(receipt.read_text(encoding="utf-8"))
            version = str(data.get("version") or "").strip()
            if version:
                return version
        except (OSError, ValueError):
            pass
    name = model_dir.resolve().name
    return name or UNIRIG_ADAPTER_VERSION


def llm_config_source(model_dir: Path) -> tuple[str, str | None]:
    """Where ``AutoConfig.from_pretrained`` should look for opt-350m.

    Returns (value for the yaml, warning message or None).
    """
    local = model_dir / "opt-350m"
    if (local / "config.json").is_file():
        return local.resolve().as_posix(), None

    hub = os.environ.get("HF_HUB_CACHE")
    hf_home = os.environ.get("HF_HOME")
    if hub:
        cache = Path(hub)
    elif hf_home:
        cache = Path(hf_home) / "hub"
    else:
        cache = Path.home() / ".cache" / "huggingface" / "hub"
    if (cache / "models--facebook--opt-350m").is_dir():
        return "facebook/opt-350m", (
            "The registry does not ship UniRig's opt-350m architecture config, so it is being "
            f"read from the local Hugging Face cache at '{cache}'. Nothing is downloaded "
            "(HF_HUB_OFFLINE=1), but this machine happens to have it cached and another "
            "machine may not."
        )
    raise AdapterError(
        "model-missing",
        "UniRig's AR model needs the 'facebook/opt-350m' architecture config (a few KB of "
        f"JSON, no weights) and it is neither at '{local}' nor in the Hugging Face cache at "
        f"'{cache}'. Downloading is disabled on purpose. Place config.json (and its tokenizer "
        f"files) under '{local}', or pre-populate the HF cache on a machine with network.",
        False,
    )


# --- VRAM sampling ------------------------------------------------------------


class VramSampler:
    """Background nvidia-smi poll, the P0-T4 pattern with no PowerShell.

    Registry ``minVramGb`` comes from MEASURED peaks, so every real run measures
    its own and the number lands in the run's provenance file. Sampling failure
    is never fatal — a rig on a machine without nvidia-smi is still a rig.
    """

    def __init__(self, interval_s: float = 0.5) -> None:
        self.interval_s = interval_s
        self.peak_mib: int | None = None
        self.total_mib: int | None = None
        self.samples = 0
        self.error: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _sample_once(self) -> None:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        first = out.stdout.strip().splitlines()[0]
        used_s, total_s = (part.strip() for part in first.split(",")[:2])
        used, total = int(used_s), int(total_s)
        self.samples += 1
        self.total_mib = total
        if self.peak_mib is None or used > self.peak_mib:
            self.peak_mib = used

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._sample_once()
            except Exception as exc:  # noqa: BLE001 - a sampler must never kill a job
                self.error = f"{type(exc).__name__}: {exc}"
                return
            self._stop.wait(self.interval_s)

    def __enter__(self) -> VramSampler:
        self._thread = threading.Thread(target=self._loop, name="vram-sampler", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    @property
    def peak_gib(self) -> float | None:
        return None if self.peak_mib is None else round(self.peak_mib / 1024.0, 2)


# --- stage execution ----------------------------------------------------------


def stage_env() -> dict[str, str]:
    """Environment for every UniRig subprocess.

    ``HF_HUB_OFFLINE`` is the second lock on the weights (the first is pointing
    ``resume_from_checkpoint`` at ``modelDir``); the rest keep a stage's output
    readable and stop it phoning anywhere.
    """
    env = dict(os.environ)
    env["HF_HUB_OFFLINE"] = "1"
    env["HF_HUB_DISABLE_TELEMETRY"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    env["TOKENIZERS_PARALLELISM"] = "false"
    env.pop("WANDB_API_KEY", None)
    env["WANDB_MODE"] = "disabled"
    return env


def run_stage(
    *,
    label: str,
    python: Path,
    home: Path,
    argv: list[str],
    log_path: Path,
    env: dict[str, str],
    expect: list[Path],
) -> str:
    """Run one stage and validate it by its ARTIFACTS, never its exit code.

    bpy tears down with 0xC0000005 on Windows after a successful extract or
    merge (P0-T4, routinely). Every stage therefore declares the files it must
    have produced, and the exit code only makes it into the error message when
    those files are missing.
    """
    cmd = [str(python), *argv]
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with log_path.open("wb") as sink:
        sink.write(("$ " + " ".join(cmd) + "\n").encode("utf-8"))
        sink.flush()
        try:
            completed = subprocess.run(
                cmd,
                cwd=str(home),
                env=env,
                stdout=sink,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                timeout=STAGE_TIMEOUT_S,
                check=False,
            )
            code: int | None = completed.returncode
        except subprocess.TimeoutExpired as exc:
            raise AdapterError(
                "backend-timeout",
                f"UniRig stage '{label}' did not finish within {STAGE_TIMEOUT_S:.0f}s. "
                f"Its log is at '{log_path}'.",
                True,
            ) from exc
        except OSError as exc:
            raise AdapterError(
                "backend-missing",
                f"Could not start UniRig stage '{label}' with '{python}': {exc}",
                False,
            ) from exc
    elapsed = time.monotonic() - started
    log = log_path.read_text(encoding="utf-8", errors="replace")

    missing = [str(p) for p in expect if not p.exists()]
    if missing:
        tail = "\n".join(log.strip().splitlines()[-25:])
        raise AdapterError(
            "backend-failed",
            f"UniRig stage '{label}' produced none of its expected output after "
            f"{elapsed:.1f}s (exit {code}); missing: {', '.join(missing)}. "
            f"Full log: '{log_path}'. Last lines:\n{tail}",
            True,
        )
    return log


# --- generated configs --------------------------------------------------------


def _yaml_quote(path: Path | str) -> str:
    """A single-quoted YAML scalar. Windows paths are written with forward
    slashes so the backslash never becomes an escape question."""
    text = Path(path).as_posix() if isinstance(path, Path) else str(path)
    return "'" + text.replace("'", "''") + "'"


def _replace_key(text: str, key: str, value: str) -> str:
    """Replace a TOP-LEVEL ``key: ...`` line, or append it."""
    pattern = re.compile(rf"^{re.escape(key)}\s*:.*$", re.MULTILINE)
    if pattern.search(text):
        return pattern.sub(f"{key}: {value}", text, count=1)
    return text.rstrip("\n") + f"\n{key}: {value}\n"


def _set_in_block(text: str, block: str, values: dict[str, str]) -> str:
    """Set ``values`` inside the top-level mapping ``block``.

    Written by hand rather than with PyYAML because the sidecar environment has
    no yaml dependency and is not getting one for two keys; the upstream configs
    this touches are plain two-space-indented mappings.
    """
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if line.rstrip() == f"{block}:"), None)
    if start is None:
        raise AdapterError(
            "backend-failed", f"UniRig config has no '{block}:' block to configure.", False
        )
    end = len(lines)
    for i in range(start + 1, len(lines)):
        line = lines[i]
        if line.strip() and not line[:1].isspace():
            end = i
            break
    indent = "  "
    for i in range(start + 1, end):
        stripped = lines[i].lstrip()
        if stripped and not stripped.startswith("#"):
            indent = lines[i][: len(lines[i]) - len(stripped)]
            break
    remaining = dict(values)
    for i in range(start + 1, end):
        stripped = lines[i].strip()
        if not stripped or stripped.startswith("#"):
            continue
        key = stripped.split(":", 1)[0].strip()
        if key in remaining:
            lines[i] = f"{indent}{key}: {remaining.pop(key)}"
    inserted = [f"{indent}{k}: {v}" for k, v in remaining.items()]
    return "\n".join(lines[: start + 1] + inserted + lines[start + 1 :]) + "\n"


def write_task_configs(
    home: Path, work: Path, skeleton_ckpt: Path, skin_ckpt: Path, llm_config: str
) -> tuple[Path, Path]:
    """Generate the two task configs this job runs, leaving upstream pristine.

    Everything the adapter needs to change about UniRig lives here: the
    checkpoint paths (so the registry's install is what runs, not the HF cache),
    the opt-350m config source, and the ``enable_flash: False`` PTv3 workaround.
    """
    skeleton_model = work / "model-ar.yaml"
    ar_text = (home / AR_MODEL).read_text(encoding="utf-8")
    skeleton_model.write_text(
        _set_in_block(ar_text, "llm", {"pretrained_model_name_or_path": _yaml_quote(llm_config)}),
        encoding="utf-8",
    )

    skin_model = work / "model-skin.yaml"
    skin_text = (home / SKIN_MODEL).read_text(encoding="utf-8")
    skin_model.write_text(
        _set_in_block(
            skin_text,
            "mesh_encoder",
            {
                # P0-T4: flash_attn_varlen_qkvpacked_func commits an illegal memory
                # access on the Windows sm_86 wheel -> all-NaN skin weights with a
                # clean exit. PTv3's standard-attention path costs +7.4 GiB.
                "enable_flash": "False",
                "upcast_attention": "True",
                "upcast_softmax": "True",
            },
        ),
        encoding="utf-8",
    )

    skeleton_task = work / "task-skeleton.yaml"
    text = (home / SKELETON_TASK).read_text(encoding="utf-8")
    text = _replace_key(text, "resume_from_checkpoint", _yaml_quote(skeleton_ckpt))
    text = _set_in_block(text, "components", {"model": _yaml_quote(skeleton_model)})
    skeleton_task.write_text(text, encoding="utf-8")

    skin_task = work / "task-skin.yaml"
    text = (home / SKIN_TASK).read_text(encoding="utf-8")
    text = _replace_key(text, "resume_from_checkpoint", _yaml_quote(skin_ckpt))
    text = _set_in_block(text, "components", {"model": _yaml_quote(skin_model)})
    skin_task.write_text(text, encoding="utf-8")
    return skeleton_task, skin_task


# --- output validation --------------------------------------------------------


def topological_order(parents: np.ndarray) -> np.ndarray:
    """A permutation putting every joint after its parent, or an error.

    ``RigJoint.parent`` must point at a LOWER index — the contract makes the
    array topologically ordered by construction so no consumer has to sort it.
    UniRig's own ``RawData.check`` asserts the same thing, but "upstream asserts
    it" is not the same as "our file has it", and a cycle here would be an
    infinite loop in every consumer.
    """
    parents = np.asarray(parents, dtype=np.int64)
    n = int(parents.shape[0])
    bad = [(i, int(p)) for i, p in enumerate(parents) if p >= n or p < -1]
    if bad:
        raise AdapterError(
            "invalid-output",
            "Predicted skeleton has out-of-range parent indices "
            + ", ".join(f"joint {i} -> {p}" for i, p in bad[:5])
            + f" (skeleton has {n} joints).",
            False,
        )
    order: list[int] = []
    placed = np.zeros(n, dtype=bool)
    remaining = list(range(n))
    while remaining:
        progressed = False
        still: list[int] = []
        for i in remaining:
            p = int(parents[i])
            if p < 0 or placed[p]:
                order.append(i)
                placed[i] = True
                progressed = True
            else:
                still.append(i)
        remaining = still
        if not progressed:
            raise AdapterError(
                "invalid-output",
                f"Predicted skeleton contains a parent cycle over joints {remaining[:8]}; "
                "it cannot be written as a topologically ordered rig.",
                False,
            )
    return np.asarray(order, dtype=np.int64)


def reorder_skeleton(
    joints: np.ndarray,
    tails: np.ndarray,
    parents: np.ndarray,
    names: list[str],
    indices: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str], np.ndarray, bool]:
    """Apply :func:`topological_order`, remapping the weight indices with it."""
    indices = np.asarray(indices, dtype=np.int64)
    count = int(np.asarray(parents).shape[0])
    if indices.size and (int(indices.min()) < 0 or int(indices.max()) >= count):
        raise AdapterError(
            "invalid-output",
            f"Weight joint indices span [{int(indices.min())}, {int(indices.max())}] but the "
            f"skeleton has {count} joints.",
            False,
        )
    order = topological_order(parents)
    if np.array_equal(order, np.arange(order.shape[0])):
        return joints, tails, np.asarray(parents, dtype=np.int64), names, indices, False
    inverse = np.empty_like(order)
    inverse[order] = np.arange(order.shape[0], dtype=np.int64)
    old_parents = np.asarray(parents, dtype=np.int64)[order]
    new_parents = np.where(old_parents < 0, -1, inverse[np.clip(old_parents, 0, None)])
    return (
        joints[order],
        tails[order],
        new_parents.astype(np.int64),
        [names[i] for i in order],
        inverse[np.asarray(indices, dtype=np.int64)],
        True,
    )


def finalize_weights(
    indices: np.ndarray, weights: np.ndarray, row_sums: np.ndarray, joint_count: int
) -> tuple[np.ndarray, np.ndarray, dict[str, int]]:
    """Bounds-check, census, renormalize — the last gate before rig.npz.

    Returns (indices, weights, counts) where ``counts`` carries
    ``unnormalizedVertices`` and ``zeroWeightVertices`` for the contract's
    ``validation`` block. ``row_sums`` is the sum of the FULL predicted row per
    vertex (before the top-4 truncation), because that is the number that says
    something about the MODEL; the truncated rows are renormalized here by
    construction and would always sum to 1.
    """
    indices = np.asarray(indices, dtype=np.int64)
    weights = np.asarray(weights, dtype=np.float64)
    if indices.shape != weights.shape:
        raise AdapterError(
            "invalid-output",
            f"weight indices {indices.shape} and values {weights.shape} disagree in shape.",
            False,
        )
    if indices.size and (int(indices.min()) < 0 or int(indices.max()) >= joint_count):
        raise AdapterError(
            "invalid-output",
            f"Weight joint indices span [{int(indices.min())}, {int(indices.max())}] but the "
            f"skeleton has {joint_count} joints; every consumer would index out of bounds.",
            False,
        )

    row_sums = np.asarray(row_sums, dtype=np.float64)
    # a non-finite row sum IS unnormalized: abs(nan - 1) > tol is False, and a
    # census that quietly answers "fine" for NaN is worse than no census
    unnormalized = int(
        np.count_nonzero(
            ~np.isfinite(row_sums) | (np.abs(row_sums - 1.0) > ROW_SUM_TOLERANCE)
        )
    )

    clean = np.where(np.isfinite(weights), weights, 0.0)
    clean = np.clip(clean, 0.0, None)
    totals = clean.sum(axis=1)
    live = totals > 0.0
    zero_weight = int(np.count_nonzero(~live))
    # GUARD, not a divide: a zero row stays zero and is counted (P0-T4 catalog
    # item 5 — upstream's unguarded renormalize is a NaN factory)
    clean[live] /= totals[live][:, None]
    if not np.isfinite(clean).all():
        raise AdapterError(
            "invalid-output",
            "Renormalized weights are still non-finite; the guard did not hold.",
            False,
        )
    return (
        indices.astype(np.int32),
        clean.astype(np.float32),
        {"unnormalizedVertices": unnormalized, "zeroWeightVertices": zero_weight},
    )


# --- semantic naming ----------------------------------------------------------


def _unit_height(points: np.ndarray) -> np.ndarray | None:
    """Normalize joint positions the way the reference table is normalized."""
    if points.shape[0] == 0:
        return None
    height = float(points[:, 1].max() - points[:, 1].min())
    if not np.isfinite(height) or height <= 0.0:
        return None
    return np.stack(
        [
            (points[:, 0] - points[:, 0].mean()) / height,
            (points[:, 1] - points[:, 1].min()) / height,
            (points[:, 2] - points[:, 2].mean()) / height,
        ],
        axis=1,
    )


def _greedy_assign(
    targets: np.ndarray, reference: np.ndarray, mirror: bool
) -> tuple[dict[int, tuple[int, float]], float]:
    """Nearest-first one-to-one matching under :data:`NAME_MATCH_THRESHOLD`."""
    probe = targets * np.array([-1.0, 1.0, 1.0]) if mirror else targets
    dist = np.linalg.norm(probe[:, None, :] - reference[None, :, :], axis=2)
    flat = np.argsort(dist, axis=None, kind="stable")
    used_t: set[int] = set()
    used_r: set[int] = set()
    pairs: dict[int, tuple[int, float]] = {}
    cost = 0.0
    for f in flat:
        ti, ri = divmod(int(f), reference.shape[0])
        d = float(dist[ti, ri])
        if d > NAME_MATCH_THRESHOLD:
            break
        if ti in used_t or ri in used_r:
            continue
        used_t.add(ti)
        used_r.add(ri)
        pairs[ti] = (ri, d)
        cost += d
    score = (cost / len(pairs) - len(pairs) * 0.01) if pairs else float("inf")
    return pairs, score


def semantic_names(
    joints: np.ndarray, fallback: list[str], parents: np.ndarray | None = None
) -> tuple[list[str], dict[str, Any]]:
    """Name predicted joints from the humanoid reference, or admit it did not.

    P0-T4 catalog item 3: ``bone_7`` breaks every name-based tool downstream, so
    a naming pass is mandatory — but inventing names is worse than not having
    them, so a joint only takes a reference name when it lands within
    :data:`NAME_MATCH_THRESHOLD` of it in unit-height space, and the mirrored
    hypothesis has to WIN BY A MARGIN before left and right are swapped.
    """
    stats: dict[str, Any] = {
        "matched": 0,
        "total": int(joints.shape[0]),
        "mirrored": False,
        "reference": HUMANOID_REFERENCE_SOURCE,
    }
    normalized = _unit_height(np.asarray(joints, dtype=np.float64))
    if normalized is None:
        return list(fallback), stats
    reference = np.array([p for _, p in HUMANOID_REFERENCE], dtype=np.float64)
    ref_names = [n for n, _ in HUMANOID_REFERENCE]

    direct, direct_score = _greedy_assign(normalized, reference, mirror=False)
    mirrored, mirrored_score = _greedy_assign(normalized, reference, mirror=True)
    use_mirror = mirrored_score < direct_score - NAME_MIRROR_MARGIN
    pairs = mirrored if use_mirror else direct

    names = list(fallback)
    for ti, (ri, _d) in pairs.items():
        names[ti] = ref_names[ri]

    # Core rescue (D-040): the retarget-critical joints re-match under a
    # looser, still-bounded radius — but ONLY when the greedy pass already
    # cleared the humanoid bar. Rescue completes an evidently-humanoid match;
    # it never creates one (the giraffe stays a giraffe). Each rescue records
    # its measured distance: report, never guess.
    rescued: dict[str, float] = {}
    if len(pairs) >= SEMANTIC_MIN_FRACTION * stats["total"]:
        probe = normalized * np.array([-1.0, 1.0, 1.0]) if use_mirror else normalized
        used_t = set(pairs.keys())
        used_r = {ri for ri, _ in pairs.values()}
        for name in CORE_RESCUE_NAMES:
            ri = ref_names.index(name)
            if ri in used_r:
                continue
            free = [ti for ti in range(probe.shape[0]) if ti not in used_t]
            if not free:
                break
            d = np.linalg.norm(probe[free] - reference[ri][None, :], axis=1)
            best = int(np.argmin(d))
            if float(d[best]) > CORE_RESCUE_THRESHOLD:
                continue
            ti = free[best]
            used_t.add(ti)
            used_r.add(ri)
            names[ti] = name
            rescued[name] = round(float(d[best]), 4)

        # The hips outranks position (D-040): a skirted or high-waisted
        # character lands its hip prediction nearer spine_01's reference,
        # chain-shifting the trunk and leaving "pelvis" unassigned - the
        # exact field failure, twice. Topology is the profile's own
        # DEFINITION of hips (the joint the legs branch from), so when both
        # thighs are named and share a parent, that parent IS the pelvis;
        # a positional name it took is released and recorded. One
        # warn-level spine hole beats an unretargetable rig.
        if parents is not None and "pelvis" not in set(names):
            named_idx = {n: i for i, n in enumerate(names)}
            tl = named_idx.get("thigh_l")
            tr = named_idx.get("thigh_r")
            if tl is not None and tr is not None:
                pl, pr = int(parents[tl]), int(parents[tr])
                if pl == pr and pl >= 0:
                    replaced = names[pl] if names[pl] != fallback[pl] else None
                    names[pl] = "pelvis"
                    ri = ref_names.index("pelvis")
                    d = float(np.linalg.norm(probe[pl] - reference[ri]))
                    rescued["pelvis"] = round(d, 4)
                    stats["pelvisByTopology"] = {"replaced": replaced}

    stats.update(
        # the truth of the final assignment, whatever path produced it - the
        # topology rescue can REPLACE a positional name, so counting pairs
        # plus rescues would double-count that joint
        matched=sum(1 for i, n in enumerate(names) if n != fallback[i]),
        mirrored=bool(use_mirror),
        directMatched=len(direct),
        mirroredMatched=len(mirrored),
        rescued=rescued,
    )
    return names, stats


# --- hints --------------------------------------------------------------------


def parse_hints(raw: Any) -> list[dict[str, Any]]:
    """RigHint[] out of the params, with the errors validate_params cannot make."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise AdapterError("bad-params", "param 'hints' must be an array of RigHint.", False)
    hints: list[dict[str, Any]] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict) or set(item) != {"joint", "position"}:
            raise AdapterError(
                "bad-params",
                f"hints[{i}] must be an object with exactly 'joint' and 'position'.",
                False,
            )
        joint = item["joint"]
        position = item["position"]
        if not isinstance(joint, str) or not joint:
            raise AdapterError("bad-params", f"hints[{i}].joint must be a non-empty string.", False)
        if (
            not isinstance(position, (list, tuple))
            or len(position) != 3
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in position)
            or not all(np.isfinite(float(v)) for v in position)
        ):
            raise AdapterError(
                "bad-params",
                f"hints[{i}].position must be three finite numbers, got {position!r}.",
                False,
            )
        hints.append({"joint": joint, "position": [float(v) for v in position]})
    return hints


def apply_hints_to_skeleton_npz(
    skeleton_npz: Path,
    align_npz: Path,
    names: list[str],
    hints: list[dict[str, Any]],
) -> dict[str, Any]:
    """Move hinted joints in the npz the SKIN stage is about to read.

    UniRig has no hint mechanism: the AR stage predicts a skeleton from geometry
    alone and cannot be conditioned on a marker. What CAN be done honestly is to
    correct the skeleton before the skin model sees it — the skin stage takes the
    joint set as INPUT, so weights predicted after this are consistent with the
    hinted placement rather than with a rest pose the user has already rejected.

    What this guarantees: the joint named by the hint ends up exactly at the
    hinted position in ``rig.json``, its tail rides along by the same delta
    (matching core's ``applyJointEdits``), and the skinning was solved against
    that skeleton. What it does NOT guarantee: the predicted TOPOLOGY — joint
    count, parents, and which joints exist at all — is whatever the AR stage
    produced; a hint cannot add a joint, and a hint that names a joint this
    prediction does not have is reported, never invented.
    """
    align = np.load(align_npz, allow_pickle=True)
    rot = np.asarray(align["rotation"], dtype=np.float64)
    scale = float(align["scale"])
    offset = np.asarray(align["offset"], dtype=np.float64)

    data = dict(np.load(skeleton_npz, allow_pickle=True))
    joints = np.asarray(data["joints"], dtype=np.float64)
    tails = np.asarray(data["tails"], dtype=np.float64) if "tails" in data else None
    by_name = {name: i for i, name in enumerate(names)}
    raw_names = [str(n) for n in list(data["names"])] if "names" in data else []
    for i, name in enumerate(raw_names):
        by_name.setdefault(name, i)

    applied: list[str] = []
    unknown: list[str] = []
    for hint in hints:
        index = by_name.get(hint["joint"])
        if index is None or index >= joints.shape[0]:
            unknown.append(hint["joint"])
            continue
        target = np.asarray(hint["position"], dtype=np.float64)
        # canonical -> unirig: the align fit is orthonormal, so its inverse is
        # the transpose; no scipy and no second fit
        wanted = ((target - offset) / scale) @ rot
        delta = wanted - joints[index]
        joints[index] = wanted
        if tails is not None:
            tails[index] = tails[index] + delta
        if "matrix_local" in data:
            local = np.asarray(data["matrix_local"], dtype=np.float64)
            if local.ndim == 3 and local.shape[0] > index:
                local[index, :3, 3] += delta
                data["matrix_local"] = local
        applied.append(hint["joint"])

    if applied:
        data["joints"] = joints.astype(np.float32)
        if tails is not None:
            data["tails"] = tails.astype(np.float32)
        np.savez(skeleton_npz, **data)
    return {"applied": applied, "unknown": unknown}


# --- output files -------------------------------------------------------------


def build_skeleton_document(
    *,
    joints: np.ndarray,
    tails: np.ndarray,
    parents: np.ndarray,
    names: list[str],
    seed: int,
    version: str,
    vertex_count: int,
    semantic: bool,
    validation: dict[str, int],
) -> dict[str, Any]:
    """The RigSkeleton object, shaped EXACTLY as rig.ts's strictObject."""
    return {
        "schemaVersion": RIG_SCHEMA_VERSION,
        "backend": {"modelId": "unirig", "version": version},
        "seed": int(seed),
        "joints": [
            {
                "name": names[i],
                "parent": int(parents[i]),
                "head": [float(v) for v in joints[i]],
                "tail": [float(v) for v in tails[i]],
            }
            for i in range(len(names))
        ],
        "semanticNames": bool(semantic),
        "vertexCount": int(vertex_count),
        "influencesPerVertex": INFLUENCES_PER_VERTEX,
        "validation": {
            "nonFiniteWeights": int(validation["nonFiniteWeights"]),
            "unnormalizedVertices": int(validation["unnormalizedVertices"]),
            "zeroWeightVertices": int(validation["zeroWeightVertices"]),
            "retries": int(validation["retries"]),
        },
    }


def verify_written_rig(skeleton_path: Path, weights_path: Path, joint_count: int) -> None:
    """Read both files back before announcing them (artifact validation).

    "The writer returned" is not evidence; a reader agreeing is. This is the
    same discipline ``verify_written_glb`` applies on the generation path.
    """
    try:
        document = json.loads(skeleton_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise AdapterError(
            "invalid-output", f"Wrote '{skeleton_path}' but cannot read it back: {exc}", False
        ) from exc
    if len(document.get("joints") or []) != joint_count:
        raise AdapterError(
            "invalid-output",
            f"'{skeleton_path}' reads back with {len(document.get('joints') or [])} joints, "
            f"expected {joint_count}.",
            False,
        )
    try:
        with np.load(weights_path) as data:
            # the CONTRACT's names (schema/rig.ts), because this is the
            # read-back that proves what core will actually find
            for key in ("joints", "weights", "primitives"):
                if key not in data:
                    raise AdapterError(
                        "invalid-output", f"'{weights_path}' has no '{key}' array.", False
                    )
            if data["joints"].shape != data["weights"].shape:
                raise AdapterError(
                    "invalid-output",
                    f"'{weights_path}' joints {data['joints'].shape} and weights "
                    f"{data['weights'].shape} disagree.",
                    False,
                )
            if int(data["weights"].shape[0]) != int(document["vertexCount"]):
                raise AdapterError(
                    "invalid-output",
                    f"'{weights_path}' has {int(data['weights'].shape[0])} rows but "
                    f"rig.json declares {document['vertexCount']} vertices.",
                    False,
                )
    except OSError as exc:
        raise AdapterError(
            "invalid-output", f"Wrote '{weights_path}' but cannot read it back: {exc}", False
        ) from exc


# --- the pipeline -------------------------------------------------------------


def _merge_result(log: str, label: str, log_path: Path) -> dict[str, Any]:
    """Pull the merge stage's JSON line out of its log, or say why not."""
    from .unirig_merge import RESULT_MARKER

    for line in reversed(log.splitlines()):
        if line.startswith(RESULT_MARKER):
            try:
                return json.loads(line[len(RESULT_MARKER) :].strip())
            except ValueError:
                break
        if line.startswith("MERGE-ERROR "):
            raise AdapterError("invalid-output", line[len("MERGE-ERROR ") :].strip(), False)
    raise AdapterError(
        "backend-failed",
        f"UniRig stage '{label}' did not report a result; its log is at '{log_path}'.",
        True,
    )


def run(params: dict[str, Any], emit: Emitter) -> None:
    p = validate_params(PARAMS_SCHEMA, params, DEFAULTS)
    mesh_path = Path(str(p["meshPath"])).resolve()
    out_dir = Path(str(p["outDir"]))
    seed = int(p["seed"])
    model_dir = Path(str(p["modelDir"]))
    hints = parse_hints(p.get("hints"))

    home = unirig_home().resolve()
    python = unirig_python()
    resolve_backend(home, python)
    skeleton_ckpt, skin_ckpt = resolve_checkpoints(model_dir)
    llm_config, llm_warning = llm_config_source(model_dir)
    if llm_warning:
        emit.warn("llm-config-from-cache", llm_warning)
    if not mesh_path.is_file():
        raise AdapterError("input-missing", f"Mesh not found: {mesh_path}", False)

    # Read the mesh we will actually rig, in the sidecar's own (tested) reader.
    scene = read_scene_geometry(mesh_path)
    if scene.has_skins:
        emit.warn(
            "mesh-already-skinned",
            f"'{mesh_path}' already contains skin data; it is ignored and a fresh rig is "
            "predicted from the geometry alone.",
        )

    # Everything upstream touches is staged under a RELATIVE, dot-free path
    # inside the clone: UniRig derives its npz mirror location from the input
    # path string, so a predictable input path is what makes the intermediates
    # findable at all.
    slug = re.sub(r"[^A-Za-z0-9_-]", "_", str(emit.job_id))[:64] or "job"
    job_rel = f"jobs/{slug}"
    work = home / job_rel
    npz_root = home / "tmp" / job_rel
    if work.exists():
        shutil.rmtree(work, ignore_errors=True)
    if npz_root.exists():
        shutil.rmtree(npz_root, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)

    staged_mesh = work / "in.glb"
    shutil.copyfile(mesh_path, staged_mesh)
    mesh_npz = work / "mesh.npz"
    np.savez(
        mesh_npz,
        positions=scene.positions.astype(np.float64),
        triangles=scene.triangles.astype(np.int64),
    )

    skeleton_task, skin_task = write_task_configs(
        home, work, skeleton_ckpt, skin_ckpt, llm_config
    )
    env = stage_env()
    stage_script = str(Path(__file__).with_name("unirig_stage.py"))
    merge_script = str(Path(__file__).with_name("unirig_merge.py"))
    stamp = time.strftime("%Y_%m_%d_%H_%M_%S", time.gmtime())
    timings: dict[str, float] = {}

    def timed(label: str, **kwargs: Any) -> str:
        started = time.monotonic()
        log = run_stage(label=label, python=python, home=home, env=env, **kwargs)
        timings[label] = round(time.monotonic() - started, 2)
        return log

    def extract(source: str, mirror: str) -> Path:
        """One bpy extract: decimate to <= 50k faces and write UniRig's npz."""
        target = npz_root / mirror / "raw_data.npz"
        timed(
            f"extract-{mirror}",
            argv=[
                stage_script,
                "--module",
                "src.data.extract",
                "--",
                f"--config={DATA_CONFIG}",
                f"--require_suffix={REQUIRE_SUFFIX}",
                "--force_override=true",
                "--num_runs=1",
                "--id=0",
                f"--time={stamp}",
                f"--faces_target_count={FACES_TARGET}",
                f"--input={job_rel}/{source}",
                "--output_dir=tmp",
            ],
            log_path=work / f"extract-{mirror}.log",
            expect=[target],
        )
        return target

    run_notes: dict[str, Any] = {
        "adapter": UNIRIG_ADAPTER_VERSION,
        "mesh": str(mesh_path),
        "modelDir": str(model_dir),
        "checkpoints": [str(skeleton_ckpt), str(skin_ckpt)],
        "llmConfig": llm_config,
        "unirigHome": str(home),
        "unirigPython": str(python),
    }

    with VramSampler() as vram:
        extract("in.glb", "in")
        emit.progress("extract", 1, 4)

        attempts: list[dict[str, Any]] = []
        last_error: AdapterError | None = None
        for attempt in range(2):
            attempt_seed = seed + attempt
            try:
                result = _predict(
                    emit=emit,
                    timed=timed,
                    stage_script=stage_script,
                    merge_script=merge_script,
                    job_rel=job_rel,
                    work=work,
                    npz_root=npz_root,
                    mesh_npz=mesh_npz,
                    skeleton_task=skeleton_task,
                    skin_task=skin_task,
                    seed=attempt_seed,
                    hints=hints,
                    attempt=attempt,
                    version=backend_version(model_dir),
                )
            except AdapterError as exc:
                if exc.code != "invalid-output" or attempt == 1:
                    raise
                last_error = exc
                attempts.append({"seed": attempt_seed, "error": exc.message})
                emit.warn(
                    "rig-retry",
                    f"UniRig's output failed validation on seed {attempt_seed} "
                    f"({exc.message}). Retrying once on seed {attempt_seed + 1}.",
                )
                continue
            result["retries"] = attempt
            result["previousAttempts"] = attempts
            break
        else:  # pragma: no cover - the loop always breaks or raises
            raise last_error or AdapterError("invalid-output", "rig prediction failed", False)

    run_notes.update(
        seed=seed,
        timingsS=timings,
        vramPeakMiB=vram.peak_mib,
        vramPeakGiB=vram.peak_gib,
        vramTotalMiB=vram.total_mib,
        vramSamples=vram.samples,
        vramError=vram.error,
        **{k: v for k, v in result.items() if k not in {"skeleton", "indices", "weights"}},
    )
    if vram.peak_mib is None:
        emit.warn(
            "vram-unmeasured",
            "Peak VRAM was not measured for this run"
            + (f" ({vram.error})" if vram.error else " (nvidia-smi produced no samples)")
            + "; the registry's minVramGb cannot be checked against it.",
        )

    # --- write, verify, announce ---------------------------------------------
    out_dir.mkdir(parents=True, exist_ok=True)
    skeleton_path = (out_dir / RIG_SKELETON_FILE).resolve()
    weights_path = (out_dir / RIG_WEIGHTS_FILE).resolve()
    skeleton_path.write_text(
        json.dumps(result["skeleton"], indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    np.savez(
        weights_path,
        joints=result["indices"],  # contract name (schema/rig.ts); see the layout note
        weights=result["weights"],
        primitives=np.array(
            [
                [s.node, s.mesh, s.primitive, s.first_vertex, s.vertex_count]
                for s in scene.primitives
            ],
            dtype=np.int32,
        ).reshape(-1, 5),
    )
    (out_dir / "rig-run.json").write_text(
        json.dumps(run_notes, indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8"
    )
    verify_written_rig(skeleton_path, weights_path, len(result["skeleton"]["joints"]))
    emit.progress("merge", 4, 4)

    if not result["skeleton"]["semanticNames"]:
        emit.warn(
            "generic-joint-names",
            f"Only {result['naming']['matched']} of {result['naming']['total']} predicted joints "
            "matched the humanoid reference, so the skeleton keeps UniRig's positional names. "
            "Name-based tools (retarget profiles, `rig --edits <joint>`) will need a manual "
            "mapping for this character.",
        )
    if result["zeroWeightVertices"]:
        emit.warn(
            "zero-weight-vertices",
            f"{result['zeroWeightVertices']} of {scene.vertex_count} vertices came back with no "
            "joint influence at all; they are written as zero rows rather than divided by zero, "
            "and will not follow the skeleton until they are weighted.",
        )

    emit.artifact(RIG_ARTIFACT_SKELETON, str(skeleton_path))
    emit.artifact(RIG_ARTIFACT_WEIGHTS, str(weights_path))

    if os.environ.get(ENV_KEEP) != "1":
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(npz_root, ignore_errors=True)


def _predict(
    *,
    emit: Emitter,
    timed: Any,
    stage_script: str,
    merge_script: str,
    job_rel: str,
    work: Path,
    npz_root: Path,
    mesh_npz: Path,
    skeleton_task: Path,
    skin_task: Path,
    seed: int,
    hints: list[dict[str, Any]],
    attempt: int,
    version: str,
) -> dict[str, Any]:
    """One full seeded prediction: skeleton -> align/name/hint -> skin -> merge.

    Split out of :func:`run` because the tier-1 NaN repair re-runs exactly this
    with ``seed + 1``; the extract stage is seed-independent and stays outside.
    """
    suffix = "" if attempt == 0 else f".retry{attempt}"
    skeleton_fbx = work / f"skeleton{suffix}.fbx"
    skin_fbx = work / f"skin{suffix}.fbx"

    timed(
        f"skeleton{suffix}",
        argv=[
            stage_script,
            "--script",
            "run.py",
            "--trust-checkpoints",
            "--",
            f"--task={skeleton_task.as_posix()}",
            f"--seed={seed}",
            f"--input={job_rel}/in.glb",
            f"--output={job_rel}/{skeleton_fbx.name}",
            "--npz_dir=tmp",
        ],
        log_path=work / f"skeleton{suffix}.log",
        expect=[skeleton_fbx],
    )

    # The skin stage consumes an npz, not the fbx: extract it back out. This is
    # also the file a hint has to move, because it is the skeleton the skin
    # model sees.
    skeleton_mirror = f"skeleton{suffix}"
    skeleton_npz = npz_root / skeleton_mirror / "raw_data.npz"
    timed(
        f"extract-{skeleton_mirror}",
        argv=[
            stage_script,
            "--module",
            "src.data.extract",
            "--",
            f"--config={DATA_CONFIG}",
            f"--require_suffix={REQUIRE_SUFFIX}",
            "--force_override=true",
            "--num_runs=1",
            "--id=0",
            f"--time={time.strftime('%Y_%m_%d_%H_%M_%S', time.gmtime())}",
            f"--faces_target_count={FACES_TARGET}",
            f"--input={job_rel}/{skeleton_fbx.name}",
            "--output_dir=tmp",
        ],
        log_path=work / f"extract-{skeleton_mirror}.log",
        expect=[skeleton_npz],
    )

    align_npz = work / f"align{suffix}.npz"
    align_log = timed(
        f"align{suffix}",
        argv=[
            merge_script,
            "--mode=align",
            f"--skeleton-npz={skeleton_npz}",
            f"--mesh-npz={mesh_npz}",
            f"--out={align_npz}",
        ],
        log_path=work / f"align{suffix}.log",
        expect=[align_npz],
    )
    align_stats = _merge_result(align_log, f"align{suffix}", work / f"align{suffix}.log")

    align = np.load(align_npz, allow_pickle=True)
    unirig_names = [str(n) for n in list(align["names"])]
    names, naming = semantic_names(
        np.asarray(align["joints"], dtype=np.float64),
        unirig_names,
        parents=np.asarray(align["parents"], dtype=np.int64),
    )
    #: bone_7 -> upperarm_l, carried by NAME so a later reorder cannot shuffle it
    name_map = dict(zip(unirig_names, names, strict=True))

    hint_report = {"applied": [], "unknown": []}
    if hints:
        hint_report = apply_hints_to_skeleton_npz(skeleton_npz, align_npz, names, hints)
        if hint_report["unknown"]:
            emit.warn(
                "hint-unknown-joint",
                "These hints name joints this prediction does not have and were ignored: "
                + ", ".join(sorted(hint_report["unknown"]))
                + ". UniRig predicts the skeleton from geometry alone, so a hint can move a "
                "joint but cannot create one.",
            )
    emit.progress("skeleton", 2, 4)

    timed(
        f"skin{suffix}",
        argv=[
            stage_script,
            "--script",
            "run.py",
            "--trust-checkpoints",
            "--",
            f"--task={skin_task.as_posix()}",
            f"--seed={seed}",
            f"--input={job_rel}/{skeleton_fbx.name}",
            f"--output={job_rel}/{skin_fbx.name}",
            "--npz_dir=tmp",
            "--data_name=raw_data.npz",
        ],
        log_path=work / f"skin{suffix}.log",
        expect=[skin_fbx],
    )
    skin_npz = _find_skin_npz(npz_root, skeleton_mirror)
    emit.progress("skin", 3, 4)

    merge_npz = work / f"merge{suffix}.npz"
    merge_log = timed(
        f"merge{suffix}",
        argv=[
            merge_script,
            "--mode=weights",
            f"--skeleton-npz={skeleton_npz}",
            f"--skin-npz={skin_npz}",
            f"--mesh-npz={mesh_npz}",
            f"--out={merge_npz}",
        ],
        log_path=work / f"merge{suffix}.log",
        expect=[merge_npz],
    )
    merge_stats = _merge_result(merge_log, f"merge{suffix}", work / f"merge{suffix}.log")

    data = np.load(merge_npz, allow_pickle=True)
    non_finite = int(merge_stats["nonFiniteWeights"]) + int(merge_stats["nonFiniteJoints"])
    if non_finite:
        raise AdapterError(
            "invalid-output",
            f"UniRig produced {merge_stats['nonFiniteWeights']} non-finite skin weights and "
            f"{merge_stats['nonFiniteJoints']} non-finite joint coordinates on seed {seed}. "
            "This is the silent-GPU-failure signature (P0-T4: flash-attn's varlen kernel "
            "faulting inside PTv3 while the stage exits 0).",
            False,
        )

    joints, tails, parents, raw_names, indices, reordered = reorder_skeleton(
        np.asarray(data["joints"], dtype=np.float64),
        np.asarray(data["tails"], dtype=np.float64),
        np.asarray(data["parents"], dtype=np.int64),
        [str(n) for n in list(data["names"])],
        np.asarray(data["indices"], dtype=np.int64),
    )
    if reordered:
        emit.warn(
            "skeleton-reordered",
            "The predicted skeleton was not topologically ordered; joints were reordered so "
            "every parent precedes its child, as the rig contract requires.",
        )
    final_names = [name_map.get(n, n) for n in raw_names]
    indices, weights, counts = finalize_weights(
        indices, np.asarray(data["weights"]), np.asarray(data["rowSums"]), len(final_names)
    )

    matched, total = naming["matched"], naming["total"]
    semantic = bool(total) and matched >= SEMANTIC_MIN_FRACTION * total

    return {
        "skeleton": build_skeleton_document(
            joints=joints,
            tails=tails,
            parents=parents,
            names=final_names,
            seed=seed,
            version=version,
            vertex_count=int(weights.shape[0]),
            semantic=semantic,
            validation={
                "nonFiniteWeights": non_finite,
                "unnormalizedVertices": counts["unnormalizedVertices"],
                "zeroWeightVertices": counts["zeroWeightVertices"],
                "retries": attempt,
            },
        ),
        "indices": indices,
        "weights": weights,
        "naming": naming,
        "hints": hint_report,
        "align": align_stats,
        "merge": merge_stats,
        "zeroWeightVertices": counts["zeroWeightVertices"],
        "unnormalizedVertices": counts["unnormalizedVertices"],
        "nonFiniteWeights": non_finite,
        "reordered": reordered,
    }


def _find_skin_npz(npz_root: Path, mirror: str) -> Path:
    """Locate the skin stage's prediction npz.

    UniRig's writer decides this path from a chain of config defaults and CLI
    overrides; rather than re-derive that chain, look where it lands and say
    exactly what was searched when it does not.
    """
    direct = npz_root / mirror / "predict_skin.npz"
    if direct.is_file():
        return direct
    found = sorted(npz_root.glob("**/predict_skin.npz"))
    if found:
        return found[0]
    raise AdapterError(
        "backend-failed",
        f"The skin stage wrote no predict_skin.npz under '{npz_root}' (expected '{direct}'). "
        "Without it there are no weights to transfer.",
        True,
    )


ADAPTER = Adapter(
    id="unirig",
    kind="rig",
    version=UNIRIG_ADAPTER_VERSION,
    params_schema=PARAMS_SCHEMA,
    defaults=DEFAULTS,
    run=run,
    description=(
        "Track B generic auto-rig (UniRig, CUDA-only). Predicts a skeleton and per-vertex skin "
        "weights for a canonical mesh and returns them as neutral data: rig.json + rig.npz, "
        "never a rigged model."
    ),
)
