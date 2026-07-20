"""Pose heuristic v1 — pure functions over the cutout alpha plane.

Produces the ``checks`` array of a PreflightReport
(``docs/architecture/data-models.ts``): each check is
``{id, status, message}`` with id in ['loaded','cutout','pose','resolution']
and status in ['ok','warn']. Messages are sentence-case, advisory tone.

v1 constants (tuned against the synthetic silhouettes in selftest.py):

- ``ARM_BAND``    rows [0.20, 0.45) of the alpha bounding-box height — where
  spread arms live on a roughly framed full-body source.
- ``TORSO_BAND``  rows [0.45, 0.70) — mid-body, where the torso dominates.
- ``SPREAD_RATIO`` 1.35 — widest arm-band row extent must exceed the median
  torso-band row extent by this factor to call the arms "spread".
- ``COVERAGE_OK`` alpha>0 fraction in [5%, 95%] reads as a plausible cutout.
- ``MIN_SHORT_SIDE`` 512 px — below this, generation quality drops.

The adapter wrapper (id ``pose-check``) runs the same heuristic standalone
over an existing RGBA cutout and writes ``<outDir>/preflight.json``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from . import Adapter, AdapterError, Emitter
from ..events import iso_now

# --- v1 heuristic constants -------------------------------------------------
ARM_BAND: tuple[float, float] = (0.20, 0.45)
TORSO_BAND: tuple[float, float] = (0.45, 0.70)
SPREAD_RATIO: float = 1.35
COVERAGE_OK: tuple[float, float] = (0.05, 0.95)
MIN_SHORT_SIDE: int = 512

POSE_CHECK_VERSION = "1.0.0"


def _check(check_id: str, status: str, message: str) -> dict[str, str]:
    return {"id": check_id, "status": status, "message": message}


def _row_extents(mask: np.ndarray) -> np.ndarray:
    """Per-row silhouette width as horizontal extent (rightmost-leftmost+1);
    0 for empty rows. Extent, not pixel count: spread arms are wide but thin."""
    any_row = mask.any(axis=1)
    extents = np.zeros(mask.shape[0], dtype=np.int64)
    if not any_row.any():
        return extents
    first = mask.argmax(axis=1)
    last = mask.shape[1] - 1 - mask[:, ::-1].argmax(axis=1)
    extents[any_row] = last[any_row] - first[any_row] + 1
    return extents


def pose_check(alpha: np.ndarray) -> dict[str, str]:
    """The 'pose' check alone. ``alpha`` is uint8 HxW."""
    mask = alpha > 0
    if not mask.any():
        return _check("pose", "warn", "No subject pixels found; cannot assess the pose.")

    rows = np.flatnonzero(mask.any(axis=1))
    top, bottom = int(rows[0]), int(rows[-1])
    bbox_h = bottom - top + 1

    arm_lo = top + int(round(ARM_BAND[0] * bbox_h))
    arm_hi = top + int(round(ARM_BAND[1] * bbox_h))
    torso_lo = top + int(round(TORSO_BAND[0] * bbox_h))
    torso_hi = top + int(round(TORSO_BAND[1] * bbox_h))
    if arm_hi <= arm_lo or torso_hi <= torso_lo:
        return _check(
            "pose", "warn", "Subject is too small to assess the pose reliably."
        )

    extents = _row_extents(mask)
    arm_widest = int(extents[arm_lo:arm_hi].max(initial=0))
    torso_rows = extents[torso_lo:torso_hi]
    torso_rows = torso_rows[torso_rows > 0]
    if arm_widest == 0 or torso_rows.size == 0:
        return _check(
            "pose", "warn", "Silhouette is too sparse to assess the pose reliably."
        )
    torso_width = float(np.median(torso_rows))

    if arm_widest >= SPREAD_RATIO * torso_width:
        return _check("pose", "ok", "Arms appear spread — good for rigging.")
    return _check(
        "pose", "warn", "Arms close to torso; an A-pose or T-pose source rigs better."
    )


def run_checks(alpha: np.ndarray) -> list[dict[str, str]]:
    """All four PreflightReport checks from the alpha plane alone. Pure."""
    if alpha.ndim != 2:
        raise ValueError(f"alpha must be HxW, got shape {alpha.shape}")
    h, w = int(alpha.shape[0]), int(alpha.shape[1])
    checks: list[dict[str, str]] = []

    checks.append(_check("loaded", "ok", f"Loaded a {w}x{h} source image."))

    coverage = float((alpha > 0).mean()) if alpha.size else 0.0
    pct = coverage * 100.0
    if coverage < COVERAGE_OK[0]:
        checks.append(
            _check(
                "cutout",
                "warn",
                f"Subject covers {pct:.1f}% of the frame; the cutout may have missed the subject.",
            )
        )
    elif coverage > COVERAGE_OK[1]:
        checks.append(
            _check(
                "cutout",
                "warn",
                f"Subject covers {pct:.1f}% of the frame; the background may not have been removed.",
            )
        )
    else:
        checks.append(
            _check("cutout", "ok", f"Subject covers {pct:.1f}% of the frame.")
        )

    checks.append(pose_check(alpha))

    if min(w, h) >= MIN_SHORT_SIDE:
        checks.append(
            _check("resolution", "ok", f"Resolution {w}x{h} is sufficient.")
        )
    else:
        checks.append(
            _check(
                "resolution",
                "warn",
                f"Resolution {w}x{h} is below {MIN_SHORT_SIDE} px on the short side; a higher-resolution source works better.",
            )
        )
    return checks


def build_preflight_report(alpha: np.ndarray) -> dict[str, Any]:
    """PreflightReport shape: {"at": iso, "checks": [...]}."""
    return {"at": iso_now(), "checks": run_checks(alpha)}


def write_preflight_report(alpha: np.ndarray, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = (out_dir / "preflight.json").resolve()
    path.write_text(
        json.dumps(build_preflight_report(alpha), indent=2) + "\n", encoding="utf-8"
    )
    return path


# --- adapter wrapper ---------------------------------------------------------

PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["imagePath", "outDir"],
    "properties": {
        "imagePath": {"type": "string"},
        "outDir": {"type": "string"},
    },
    "additionalProperties": False,
}


def run(params: dict[str, Any], emit: Emitter) -> None:
    from PIL import Image  # local import keeps registry construction light

    try:
        image_path = Path(str(params["imagePath"]))
        out_dir = Path(str(params["outDir"]))
    except KeyError as exc:
        raise AdapterError("bad-params", f"missing param: {exc}", False) from exc

    if not image_path.is_file():
        raise AdapterError(
            "input-missing", f"Input image not found: {image_path}", False
        )

    try:
        with Image.open(image_path) as img:
            rgba = img.convert("RGBA")
    except OSError as exc:
        # UnidentifiedImageError subclasses OSError — permanent input error
        raise AdapterError(
            "input-invalid",
            f"Cannot read '{image_path}' as an image: {exc}",
            False,
        ) from exc
    alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
    emit.progress("analyze", 1, 1)

    path = write_preflight_report(alpha, out_dir)
    emit.artifact("preflight", str(path))


ADAPTER = Adapter(
    id="pose-check",
    kind="imageprep",
    version=POSE_CHECK_VERSION,
    params_schema=PARAMS_SCHEMA,
    defaults={},
    run=run,
    description="Pose heuristic v1 over an existing RGBA cutout; writes preflight.json.",
)
