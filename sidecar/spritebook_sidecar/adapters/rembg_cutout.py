"""rembg cutout adapter (kind ``imageprep``) — fully offline, always.

Model-path mechanism (verified against the PINNED rembg 2.0.77 source in
``sidecar/.venv/Lib/site-packages/rembg``):

- ``BaseSession.__init__`` unconditionally resolves the model file through
  ``cls.download_models(*args, **kwargs)``; ``U2netSession.download_models``
  calls ``pooch.retrieve(<github url>, md5, path=U2NET_HOME)`` which WILL hit
  the network whenever the file is missing OR its hash mismatches. Setting
  ``U2NET_HOME`` alone therefore CANNOT guarantee offline behavior.
- ``BaseSession.__init__`` forwards its extra kwargs to ``download_models``,
  so the one mechanism that cannot download is a subclass whose
  ``download_models`` override returns a caller-supplied local path and never
  touches pooch. That is :class:`_OfflineU2netSession` below. pooch is never
  invoked on any code path of this adapter.

The adapter verifies ``<modelDir>/u2net.onnx`` exists BEFORE importing rembg
or loading anything; a missing file is AdapterError('model-missing') naming
the exact expected path and the fix.

Output validation (sidecar-vram law — an adapter without it is not done):
alpha-plane stats on the cutout. All-zero alpha -> AdapterError
('empty-cutout'); all-255 alpha (nothing removed) -> warn 'cutout-noop';
coverage (alpha>0 fraction) feeds the preflight 'cutout' check.
"""

from __future__ import annotations

from importlib.metadata import version as _pkg_version
from pathlib import Path
from typing import Any

import numpy as np

from . import Adapter, AdapterError, Emitter
from .pose_check import write_preflight_report

REMBG_VERSION = _pkg_version("rembg")

PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["imagePath", "outDir", "modelDir"],
    "properties": {
        "imagePath": {"type": "string"},
        "outDir": {"type": "string"},
        "modelDir": {"type": "string"},
        "model": {"type": "string", "enum": ["u2net"]},
    },
    "additionalProperties": False,
}

DEFAULTS: dict[str, Any] = {"model": "u2net"}


def _offline_session(model_path: Path):
    """Create a rembg session that can ONLY load ``model_path`` — no pooch,
    no network, no fallback. Heavy imports live here, not at module scope."""
    import onnxruntime as ort
    from rembg.sessions.u2net import U2netSession

    class _OfflineU2netSession(U2netSession):
        @classmethod
        def download_models(cls, *args, **kwargs):  # noqa: N802 (upstream name)
            path = kwargs.get("model_path")
            if not path or not Path(path).is_file():
                # Defense in depth; run() already checked existence.
                raise AdapterError(
                    "model-missing", f"Model file not found: {path}", False
                )
            return str(path)

    return _OfflineU2netSession(
        "u2net",
        ort.SessionOptions(),
        providers=["CPUExecutionProvider"],
        model_path=str(model_path),
    )


def run(params: dict[str, Any], emit: Emitter) -> None:
    try:
        image_path = Path(str(params["imagePath"]))
        out_dir = Path(str(params["outDir"]))
        model_dir = Path(str(params["modelDir"]))
    except KeyError as exc:
        raise AdapterError("bad-params", f"missing param: {exc}", False) from exc
    model = str(params.get("model", DEFAULTS["model"]))
    if model != "u2net":
        raise AdapterError("bad-params", f"unsupported model: {model}", False)

    # BEFORE loading anything: the weight must already be installed.
    model_path = (model_dir / f"{model}.onnx").resolve()
    if not model_path.is_file():
        raise AdapterError(
            "model-missing",
            f"Model file not found: {model_path}. "
            "Run `spritebook models install rembg-u2net` to install it.",
            False,
        )
    if not image_path.is_file():
        raise AdapterError(
            "input-missing", f"Input image not found: {image_path}", False
        )

    from PIL import Image
    from rembg.bg import remove

    session = _offline_session(model_path)
    emit.progress("load", 1, 3)

    with Image.open(image_path) as img:
        img.load()
        cutout = remove(img, session=session)
    if cutout.mode != "RGBA":
        cutout = cutout.convert("RGBA")
    emit.progress("infer", 2, 3)

    # Output validation (sidecar-vram): never trust "ran" to mean "right".
    alpha = np.asarray(cutout.getchannel("A"), dtype=np.uint8)
    if int(alpha.max(initial=0)) == 0:
        raise AdapterError(
            "empty-cutout",
            "Cutout alpha is entirely transparent; no subject was detected.",
            False,
        )
    if int(alpha.min(initial=255)) == 255:
        emit.warn(
            "cutout-noop",
            "Cutout alpha is fully opaque; no background was removed.",
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    cutout_path = (out_dir / "cutout.png").resolve()
    cutout.save(cutout_path, format="PNG")
    emit.progress("encode", 3, 3)
    emit.artifact("cutout", str(cutout_path))

    preflight_path = write_preflight_report(alpha, out_dir)
    emit.artifact("preflight", str(preflight_path))


ADAPTER = Adapter(
    id="rembg",
    kind="imageprep",
    version=REMBG_VERSION,
    params_schema=PARAMS_SCHEMA,
    defaults=DEFAULTS,
    run=run,
    description="Background removal via rembg u2net (offline; weights from modelDir only).",
)
