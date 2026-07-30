"""Fixture generator (kind ``gen3d``) — the deterministic stand-in backend.

What ``echo`` is to the job protocol, ``fixture-gen`` is to the generation path:
it lets the WHOLE image -> raw.glb -> border -> canonical chain be built and
CI-tested with no GPU, no weights, and no network. It is deliberately not a
mime — it produces a real textured glb whose geometry and texture both depend on
the source image, so an acceptance test that runs it is testing the chain, not a
placeholder.

``modelDir`` is accepted and IGNORED. fixture-gen has no weights to install, but
every gen3d adapter receives the frozen ``GenAdapterParams`` shape
(``packages/schema/gen.ts``), so refusing the field would make core special-case
this backend for no reason.

## How the source image becomes a mesh

The mesh is a solid of revolution of the source silhouette:

- the alpha bounding box sets the world proportions — the figure stands
  ``TARGET_HEIGHT_M`` tall with its width scaled to the source's bbox aspect, so
  a wide sprite yields a wide body;
- each latitude ring's radius is that row's SILHOUETTE EXTENT (the same
  measure the pose heuristic uses), resampled across the bbox — the profile
  literally is the subject's outline;
- the bbox FILL fraction (coverage) sets how deep the body is: a solid
  silhouette becomes a rounder cross-section, a sparse one stays slab-like;
- the aspect ratio also splits the triangle budget between rings and segments,
  so a tall subject gets tall tessellation.

Convention (D-012, and what the P1 border enforces): +Y up, metres, feet at
Y=0, facing +Z. The facing is real rather than nominal — the cross-section is
squashed along Z and the head carries a forward bulge on the +Z side.

## Determinism

gen.ts pins provenance to bytes, so same (imagePath, seed, params) must give a
byte-identical raw.glb. The ONLY randomness is a ``default_rng(seed)`` radial
jitter field (smoothed, seam-matched, and zeroed at the poles so the mesh stays
closed); there is no clock, no unseeded RNG, no set/dict iteration order in the
output path, and floats reach the JSON only through ``float()`` on numpy
scalars. Different seeds move every ring by up to ``JITTER_AMP``, so they differ
visibly rather than in the last bit.

## Output validation (sidecar-vram law)

Before the artifact event: NaN/Inf census on positions/normals/UVs, index-bounds
check, degenerate-triangle fraction, UV band sanity, texture non-uniformity, and
a full re-read of the written glb. An adapter without output validation is not
done.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from . import Adapter, AdapterError, Emitter, validate_params
from ..glb import validate_mesh, validate_texture, verify_written_glb, write_glb
from .pose_check import _row_extents

FIXTURE_GEN_VERSION = "1.0.0"

#: mirrors packages/schema/gen.ts (FROZEN): the raw backend output filename and
#: the mandatory artifact kind for a gen3d adapter.
RAW_MODEL = "raw.glb"
GEN_ARTIFACT_MESH = "mesh-raw"
#: candidate i's base seed is seed + i * SEED_STRIDE (same convention as trellis2)
SEED_STRIDE = 1000

# --- shape constants ----------------------------------------------------------

#: D-012 scale convention: a standing figure is ~1.7 m tall, feet at Y=0.
TARGET_HEIGHT_M = 1.7
#: floor on the normalized ring radius, so a pinched row cannot collapse the
#: mesh into degenerate triangles mid-body
MIN_PROFILE = 0.06
#: fraction of the height over which the caps taper to the poles; outside it the
#: radius is exactly the silhouette's
CAP_FRACTION = 0.06
#: cross-section depth as a fraction of width, interpolated by bbox fill
DEPTH_MIN, DEPTH_SPAN = 0.30, 0.40
#: forward (+Z) bulge that makes "facing +Z" a property of the geometry
FACE_BULGE = 0.55
FACE_V, FACE_SIGMA = 0.09, 0.045
#: peak seed-driven radial perturbation, as a fraction of the ring radius
JITTER_AMP = 0.08
#: tessellation clamps
MIN_SEGMENTS, MAX_SEGMENTS = 6, 256
MIN_RINGS, MAX_RINGS = 3, 512

PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["imagePath", "outDir", "seed"],
    "properties": {
        "imagePath": {"type": "string", "minLength": 1},
        "outDir": {"type": "string", "minLength": 1},
        "seed": {"type": "integer", "minimum": 0},
        # N candidates in one job, seeds strided by SEED_STRIDE - here for the
        # same reason echo exists: the whole candidates path is testable with
        # no GPU and no download
        "candidates": {"type": "integer", "minimum": 1, "maximum": 8},
        # accepted for GenAdapterParams uniformity; fixture-gen has no weights
        "modelDir": {"type": "string"},
        "tris": {"type": "integer", "minimum": 64, "maximum": 50000},
        "textureSize": {"type": "integer", "enum": [256, 512, 1024]},
    },
    "additionalProperties": False,
}

DEFAULTS: dict[str, Any] = {"tris": 2000, "textureSize": 512, "candidates": 1}


# --- source image -------------------------------------------------------------


@dataclass(frozen=True)
class SourceImage:
    """A cut-out RGBA source, reduced to what generation actually consumes.

    ``rgb_filled`` is the source composited over its own subject-mean colour, so
    sampling never picks up background pixels the cutout already rejected; the
    bbox fields are the alpha silhouette's tight bounds.
    """

    path: Path
    rgb_filled: np.ndarray  # (H, W, 3) float64, 0..255
    alpha: np.ndarray  # (H, W) uint8
    mask: np.ndarray  # (H, W) bool
    top: int
    bottom: int
    left: int
    right: int
    mean_rgb: np.ndarray  # (3,) float64

    @property
    def bbox_h(self) -> int:
        return self.bottom - self.top + 1

    @property
    def bbox_w(self) -> int:
        return self.right - self.left + 1

    @property
    def aspect(self) -> float:
        """bbox height / width — tall subjects are > 1."""
        return self.bbox_h / self.bbox_w

    @property
    def fill(self) -> float:
        """Opaque fraction WITHIN the bbox (coverage): 1.0 is a solid block."""
        return float(self.mask[self.top : self.bottom + 1, self.left : self.right + 1].mean())


def load_source(image_path: Path) -> SourceImage:
    """Read the cut-out RGBA source and measure its silhouette.

    Shared with the texture substage — both stages need the same bbox, mask and
    background-free colour field, and measuring them twice is how the two drift.
    """
    from PIL import Image  # local import keeps registry construction light

    if not image_path.is_file():
        raise AdapterError("input-missing", f"Input image not found: {image_path}", False)
    try:
        with Image.open(image_path) as img:
            rgba = img.convert("RGBA")
    except OSError as exc:
        # UnidentifiedImageError subclasses OSError — a permanent input error
        raise AdapterError(
            "input-invalid", f"Cannot read '{image_path}' as an image: {exc}", False
        ) from exc

    arr = np.asarray(rgba, dtype=np.uint8)
    rgb = arr[:, :, :3].astype(np.float64)
    alpha = arr[:, :, 3]
    mask = alpha > 0
    if not mask.any():
        raise AdapterError(
            "empty-silhouette",
            f"'{image_path}' is fully transparent: no opaque pixels, so there is no subject "
            "to generate from. Run `spritebook prep` on a source whose subject survives "
            "background removal (the preflight 'cutout' check reports coverage).",
            False,
        )

    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    top, bottom = int(rows[0]), int(rows[-1])
    left, right = int(cols[0]), int(cols[-1])
    if (bottom - top + 1) < 2 or (right - left + 1) < 2:
        raise AdapterError(
            "silhouette-too-small",
            f"'{image_path}' has a {right - left + 1}x{bottom - top + 1} px subject; at least "
            "2x2 opaque pixels are needed to derive a shape. The cutout almost certainly "
            "missed the subject.",
            False,
        )

    mean_rgb = rgb[mask].mean(axis=0)
    a = (alpha.astype(np.float64) / 255.0)[:, :, None]
    rgb_filled = rgb * a + mean_rgb[None, None, :] * (1.0 - a)
    return SourceImage(
        path=image_path,
        rgb_filled=rgb_filled,
        alpha=alpha,
        mask=mask,
        top=top,
        bottom=bottom,
        left=left,
        right=right,
        mean_rgb=mean_rgb,
    )


# --- mesh -------------------------------------------------------------------


def tessellation(tris: int, aspect: float) -> tuple[int, int]:
    """Split a triangle budget into (rings, segments) along the source aspect.

    A UV body with ``n_lat`` ring bands and ``n_lon`` segments emits
    ``2 * n_lon * (n_lat - 1)`` triangles once the two pole rows drop their
    degenerate halves, so solving that for the requested budget while holding
    ``n_lat / n_lon ~= aspect`` spends the budget where the subject is long.
    """
    aspect = min(max(aspect, 0.25), 6.0)
    n_lon = int(round(math.sqrt(tris / (2.0 * aspect))))
    n_lon = min(max(n_lon, MIN_SEGMENTS), MAX_SEGMENTS)
    n_lat = int(round(tris / (2.0 * n_lon) + 1.0))
    n_lat = min(max(n_lat, MIN_RINGS), MAX_RINGS)
    return n_lat, n_lon


def _smooth_cyclic(field: np.ndarray, passes: int = 2) -> np.ndarray:
    """3-tap blur, wrapping in longitude and clamping in latitude.

    Raw per-vertex noise makes a spiky mesh with meaningless normals; smoothing
    turns the same seed into a gently lumpy body. Pure array math, so it stays
    bit-reproducible.
    """
    for _ in range(passes):
        field = (np.roll(field, 1, axis=1) + 2.0 * field + np.roll(field, -1, axis=1)) / 4.0
        up = np.vstack([field[:1], field[:-1]])
        down = np.vstack([field[1:], field[-1:]])
        field = (up + 2.0 * field + down) / 4.0
    return field


def _grid_indices(n_lat: int, n_lon: int) -> np.ndarray:
    """Triangle list for an (n_lat+1) x (n_lon+1) vertex grid, wound outward.

    Quad (i, j) has corners A=(i,j) B=(i+1,j) C=(i+1,j+1) D=(i,j+1). The winding
    (A,C,B) / (A,D,C) puts face normals AWAY from the axis (verified by the
    selftest's outward-normal check). The top pole row drops (A,D,C) and the
    bottom pole row drops (A,C,B): at a pole those two corners coincide, so the
    triangle would be exactly the zero-area garbage our own validator refuses.
    """
    i = np.arange(n_lat, dtype=np.int64)[:, None]
    j = np.arange(n_lon, dtype=np.int64)[None, :]
    row = n_lon + 1
    a = i * row + j
    b = (i + 1) * row + j
    c = (i + 1) * row + j + 1
    d = i * row + j + 1
    t1 = np.stack([a, c, b], axis=-1)[: n_lat - 1].reshape(-1, 3)
    t2 = np.stack([a, d, c], axis=-1)[1:].reshape(-1, 3)
    return np.concatenate([t1, t2], axis=0).reshape(-1)


def _vertex_normals(positions: np.ndarray, indices: np.ndarray) -> np.ndarray:
    """Area-weighted vertex normals, computed FROM the float32 positions.

    Deriving them from the values that actually land in the file keeps the glb
    self-consistent; ``np.add.at`` is a serial scatter, so the accumulation order
    is fixed and the result reproducible.
    """
    tri = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    p = np.asarray(positions, dtype=np.float64)
    face = np.cross(p[tri[:, 1]] - p[tri[:, 0]], p[tri[:, 2]] - p[tri[:, 0]])
    acc = np.zeros(p.shape, dtype=np.float64)
    for k in range(3):
        np.add.at(acc, tri[:, k], face)
    lens = np.linalg.norm(acc, axis=1)
    safe = lens > 1e-20
    acc[safe] /= lens[safe][:, None]
    if not safe.all():
        # Only reachable for a vertex no triangle references (the two seam
        # duplicates at the poles). Point them along the axis, away from centre.
        centre_y = float(p[:, 1].mean())
        sign = np.where(p[~safe, 1] >= centre_y, 1.0, -1.0)
        fallback = np.zeros((int((~safe).sum()), 3), dtype=np.float64)
        fallback[:, 1] = sign
        acc[~safe] = fallback
    return acc.astype(np.float32)


def build_mesh(
    source: SourceImage, seed: int, tris: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """(positions, normals, uvs, indices) for the seed-perturbed body."""
    n_lat, n_lon = tessellation(tris, source.aspect)

    # v runs 0 (head) -> 1 (feet), matching image rows top -> bottom.
    v = np.linspace(0.0, 1.0, n_lat + 1)

    # Ring radius = that image row's silhouette extent, normalized by bbox width.
    extents = _row_extents(source.mask)[source.top : source.bottom + 1].astype(np.float64)
    profile = np.interp(v, np.linspace(0.0, 1.0, source.bbox_h), extents / source.bbox_w)
    profile = np.maximum(profile, MIN_PROFILE)
    # Taper to closed poles over the top/bottom CAP_FRACTION of the height.
    cap = np.sqrt(np.clip(np.minimum(v, 1.0 - v) / CAP_FRACTION, 0.0, 1.0))

    rng = np.random.default_rng(seed)
    jitter = _smooth_cyclic(rng.uniform(-1.0, 1.0, size=(n_lat + 1, n_lon)))
    # The seam column is a DUPLICATE of column 0 (same position, u=1 vs u=0), so
    # it must carry the same jitter or the body splits open along the seam.
    jitter = np.concatenate([jitter, jitter[:, :1]], axis=1)

    theta = 2.0 * math.pi * np.arange(n_lon + 1, dtype=np.float64) / n_lon
    half_width = 0.5 * TARGET_HEIGHT_M / source.aspect  # = 0.5 * H * bbox_w / bbox_h
    radius = (half_width * profile * cap)[:, None] * (1.0 + JITTER_AMP * jitter)
    depth = DEPTH_MIN + DEPTH_SPAN * source.fill

    x = radius * np.cos(theta)[None, :]
    z = radius * depth * np.sin(theta)[None, :]
    # Forward bulge on the +Z hemisphere of the head band: what makes +Z the face.
    face = np.exp(-(((v - FACE_V) / FACE_SIGMA) ** 2))[:, None] * np.clip(
        np.sin(theta), 0.0, None
    )[None, :]
    z = z + face * (cap * half_width * FACE_BULGE)[:, None]
    y = np.repeat((TARGET_HEIGHT_M * (1.0 - v))[:, None], n_lon + 1, axis=1)

    positions = np.stack([x, y, z], axis=-1).reshape(-1, 3).astype(np.float32)
    u_grid = np.repeat((np.arange(n_lon + 1, dtype=np.float64) / n_lon)[None, :], n_lat + 1, 0)
    v_grid = np.repeat(v[:, None], n_lon + 1, axis=1)
    uvs = np.stack([u_grid, v_grid], axis=-1).reshape(-1, 2).astype(np.float32)
    indices = _grid_indices(n_lat, n_lon)
    normals = _vertex_normals(positions, indices)
    return positions, normals, uvs, indices


# --- texture ------------------------------------------------------------------


def bake_texture(source: SourceImage, size: int) -> np.ndarray:
    """Cylindrical projection of the source into the mesh's equirect UV layout.

    Column u maps to the angle theta = 2*pi*u around the body, and the sampled
    source column is ``0.5 + 0.5*cos(theta)`` across the bbox — so u=0.25
    (theta=pi/2, the +Z front) reads the CENTRE of the sprite, the sides read the
    sprite's edges, and the back reads the front mirrored. Row v maps straight
    down the bbox, matching the mesh's v. The seam at u=0/u=1 lands on the same
    column, so the wrap is continuous.

    A facing term darkens the back. It is not decoration: it guarantees tonal
    variation for any real subject, which is what lets a flat output be treated
    as the failure it almost always is (see :func:`validate_texture`).
    """
    u = (np.arange(size, dtype=np.float64) + 0.5) / size
    v = (np.arange(size, dtype=np.float64) + 0.5) / size
    theta = 2.0 * math.pi * u

    sx = 0.5 + 0.5 * np.cos(theta)
    cols = source.left + np.rint(sx * (source.bbox_w - 1)).astype(np.int64)
    rows = source.top + np.rint(v * (source.bbox_h - 1)).astype(np.int64)
    cols = np.clip(cols, source.left, source.right)
    rows = np.clip(rows, source.top, source.bottom)

    rgb = source.rgb_filled[rows[:, None], cols[None, :]]  # (size, size, 3)
    shade = 0.72 + 0.28 * np.clip(np.sin(theta), 0.0, None)
    return np.clip(rgb * shade[None, :, None], 0.0, 255.0).astype(np.uint8)


def encode_png(rgb: np.ndarray) -> bytes:
    """RGB array -> PNG bytes, deterministically.

    ``compress_level`` is pinned rather than left to Pillow's default so the
    byte stream cannot move under us; Pillow writes no tIME chunk, so there is
    no clock in the output.
    """
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(rgb, dtype=np.uint8), mode="RGB").save(
        buf, format="PNG", optimize=False, compress_level=6
    )
    return buf.getvalue()


# --- adapter ------------------------------------------------------------------


def run(params: dict[str, Any], emit: Emitter) -> None:
    p = validate_params(PARAMS_SCHEMA, params, DEFAULTS)
    image_path = Path(str(p["imagePath"]))
    out_dir = Path(str(p["outDir"]))
    seed = int(p["seed"])
    tris = int(p["tris"])
    tex_size = int(p["textureSize"])

    source = load_source(image_path)
    candidates = int(p["candidates"])
    out_paths: list[Path] = []
    for c in range(candidates):
        # the same stride convention as the real backends, so core's
        # fallback-seed accounting is one rule everywhere
        cand_seed = seed + c * SEED_STRIDE
        positions, normals, uvs, indices = build_mesh(source, cand_seed, tris)
        emit.progress(f"shape:{c + 1}/{candidates}", c * 3 + 1, 3 * candidates)

        # Output validation BEFORE anything is written or announced.
        mesh_stats = validate_mesh(positions, normals, uvs, indices)

        texture = bake_texture(source, tex_size)
        emit.progress(f"texture:{c + 1}/{candidates}", c * 3 + 2, 3 * candidates)
        validate_texture(texture)

        generator = (
            f"spritebook-fixture-gen/{FIXTURE_GEN_VERSION} "
            f"(seed={cand_seed}; tris={mesh_stats['triangles']}; tex={tex_size})"
        )
        name = RAW_MODEL if c == 0 else f"raw-{c}.glb"
        out_path = (out_dir / name).resolve()
        write_glb(
            out_path,
            positions=positions,
            normals=normals,
            uvs=uvs,
            indices=indices,
            texture_png=encode_png(texture),
            generator=generator,
        )
        emit.progress(f"encode:{c + 1}/{candidates}", c * 3 + 3, 3 * candidates)

        # Artifact validation over exit codes: prove a reader agrees before we
        # announce the file to core.
        verify_written_glb(
            out_path,
            expect_vertices=int(positions.shape[0]),
            expect_indices=int(indices.size),
            expect_texture=True,
        )
        out_paths.append(out_path)

    # one mesh-raw per candidate, in INDEX ORDER - core pairs them positionally
    for out_path in out_paths:
        emit.artifact(GEN_ARTIFACT_MESH, str(out_path))


ADAPTER = Adapter(
    id="fixture-gen",
    kind="gen3d",
    version=FIXTURE_GEN_VERSION,
    params_schema=PARAMS_SCHEMA,
    defaults=DEFAULTS,
    run=run,
    description=(
        "Deterministic GPU-free gen3d stand-in: a seed-perturbed solid of revolution of the "
        "source silhouette, textured from the source, written as raw.glb."
    ),
)
