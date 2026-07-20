"""Texture substage — give a geometry-only backend's mesh a texture.

Runs when a catalog entry declares ``outputs.texture == false``: the backend
produced shape but no surface, and the border refuses to be the place where a
character silently becomes untextured. The substage projects the CUT-OUT
source image onto the mesh's EXISTING UVs and writes a textured glb.

Geometry is sacred here. The mesh arrives from a backend that has already
decided what the character's shape is, so every position, normal, UV and index
is written back verbatim and re-read to prove it (:func:`verify_written_glb`);
only the texture is new. A substage that quietly re-indexed or welded the mesh
would invalidate the shape the user is about to pick.

## Relationship to core's reprojection

``packages/gen/reproject.ts`` runs the same front-orthographic idea AFTER the
border, as the detail pass a user asks for with ``pick --reproject``, and it
carries a depth pre-pass for occlusion. This substage runs BEFORE the border,
inside the sidecar, and exists to make an untextured mesh legal at all — so it
deliberately stays the simpler of the two. Both state the same assumption out
loud: an image-to-3D backend is conditioned on one front-facing view, so the
source is treated as an orthographic front view fitted to the mesh bounds.
Texels the projection cannot see keep a neutral fill derived from the
subject's own mean colour rather than inventing detail.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np

from ..glb import (
    build_glb,
    read_glb,
    validate_mesh,
    validate_texture,
    verify_written_glb,
)
from . import Adapter, AdapterError, Emitter, validate_params
from .fixture_gen import SourceImage, encode_png, load_source

TEXTURE_SUBSTAGE_VERSION = "1.0.0"

PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["meshPath", "imagePath", "outDir"],
    "properties": {
        "meshPath": {"type": "string"},
        "imagePath": {"type": "string"},
        "outDir": {"type": "string"},
        "seed": {"type": "integer", "minimum": 0},
        "textureSize": {"type": "integer", "enum": [256, 512, 1024]},
        # accepted and ignored: core hands every gen3d adapter the same block
        "modelDir": {"type": "string"},
    },
    "additionalProperties": False,
}

DEFAULTS: dict[str, Any] = {"seed": 0, "textureSize": 512}

OUTPUT_NAME = "textured.glb"


# --- projection ---------------------------------------------------------------


def _front_projection(
    positions: np.ndarray, source: SourceImage
) -> tuple[np.ndarray, np.ndarray]:
    """Per-vertex source pixel (row, col) under an orthographic front fit.

    World +X runs to image right and world +Y up runs to image row 0, matching
    the convention the renderer and core's reprojection both use. The fit
    preserves aspect — one scale for the whole subject — so a tall mesh does not
    get stretched across a square sprite.
    """
    xs, ys = positions[:, 0], positions[:, 1]
    span_x = max(float(xs.max() - xs.min()), 1e-6)
    span_y = max(float(ys.max() - ys.min()), 1e-6)
    scale = min(source.bbox_w / span_x, source.bbox_h / span_y)
    cx = float(xs.min() + xs.max()) / 2.0
    cy = float(ys.min() + ys.max()) / 2.0

    col_centre = source.left + source.bbox_w / 2.0
    row_centre = source.top + source.bbox_h / 2.0
    cols = np.rint(col_centre + (xs - cx) * scale).astype(np.int64)
    rows = np.rint(row_centre - (ys - cy) * scale).astype(np.int64)
    np.clip(cols, source.left, source.right, out=cols)
    np.clip(rows, source.top, source.bottom, out=rows)
    return rows, cols


def bake_projected_texture(
    positions: np.ndarray,
    normals: np.ndarray,
    uvs: np.ndarray,
    indices: np.ndarray,
    source: SourceImage,
    size: int,
) -> np.ndarray:
    """Rasterize the mesh into UV space, colouring texels from the source.

    Per triangle: walk the texels its UVs cover, interpolate the vertex colour
    and facing barycentrically, and keep the sample only where the surface
    faces the camera. Unpainted texels stay at the subject's mean colour, which
    is a neutral that belongs to this character rather than a grey that belongs
    to no one.
    """
    rows, cols = _front_projection(positions, source)
    vertex_rgb = source.rgb_filled[rows, cols]  # (V, 3) float64
    facing = normals[:, 2].astype(np.float64)  # +Z is toward the camera

    fill = np.clip(source.mean_rgb, 0.0, 255.0)
    tex = np.repeat(np.repeat(fill.reshape(1, 1, 3), size, axis=0), size, axis=1)
    painted = np.zeros((size, size), dtype=bool)

    # glTF UV origin is top-left with v increasing downward, so v maps straight
    # to the texel row and no flip is needed here
    px = uvs[:, 0] * size
    py = uvs[:, 1] * size

    for tri in indices.reshape(-1, 3):
        a, b, c = int(tri[0]), int(tri[1]), int(tri[2])
        x0, y0 = px[a], py[a]
        x1, y1 = px[b], py[b]
        x2, y2 = px[c], py[c]
        det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(det) < 1e-12:
            continue  # zero-area in UV space paints nothing
        min_x = max(0, int(math.floor(min(x0, x1, x2))))
        max_x = min(size - 1, int(math.ceil(max(x0, x1, x2))))
        min_y = max(0, int(math.floor(min(y0, y1, y2))))
        max_y = min(size - 1, int(math.ceil(max(y0, y1, y2))))
        if min_x > max_x or min_y > max_y:
            continue

        gx = np.arange(min_x, max_x + 1, dtype=np.float64) + 0.5
        gy = np.arange(min_y, max_y + 1, dtype=np.float64) + 0.5
        qx = gx[None, :]
        qy = gy[:, None]
        l0 = ((y1 - y2) * (qx - x2) + (x2 - x1) * (qy - y2)) / det
        l1 = ((y2 - y0) * (qx - x2) + (x0 - x2) * (qy - y2)) / det
        l2 = 1.0 - l0 - l1
        inside = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6)
        if not inside.any():
            continue
        face = l0 * facing[a] + l1 * facing[b] + l2 * facing[c]
        take = inside & (face > 1e-3)
        if not take.any():
            continue
        colour = (
            l0[..., None] * vertex_rgb[a]
            + l1[..., None] * vertex_rgb[b]
            + l2[..., None] * vertex_rgb[c]
        )
        block = tex[min_y : max_y + 1, min_x : max_x + 1]
        np.copyto(block, np.clip(colour, 0.0, 255.0), where=take[..., None])
        painted[min_y : max_y + 1, min_x : max_x + 1] |= take

    if not painted.any():
        raise AdapterError(
            "invalid-output",
            "The projection painted no texels at all: every triangle was back-facing or "
            "its UVs were degenerate. The mesh does not face +Z the way an image-to-3D "
            "result is expected to, so texturing it from a front view is meaningless.",
            False,
        )
    return np.clip(tex, 0.0, 255.0).astype(np.uint8)


# --- adapter ------------------------------------------------------------------


def run(params: dict[str, Any], emit: Emitter) -> None:
    p = validate_params(PARAMS_SCHEMA, params, DEFAULTS)
    mesh_path = Path(str(p["meshPath"]))
    out_dir = Path(str(p["outDir"]))
    size = int(p["textureSize"])

    mesh = read_glb(mesh_path)
    emit.progress("load", 1, 3)

    if mesh.uvs is None:
        raise AdapterError(
            "no-uvs",
            f"'{mesh_path}' has no TEXCOORD_0, so there is nowhere to put a texture. A "
            "geometry-only backend that emits no UVs needs an unwrap stage, which "
            "SpriteBook does not have yet - use a backend whose outputs declare texture "
            "support, or one that emits UVs.",
            False,
        )
    if mesh.normals is None:
        raise AdapterError(
            "no-normals",
            f"'{mesh_path}' has no NORMAL attribute, so front-facing surfaces cannot be "
            "told from back-facing ones and every texel would be painted from the front "
            "view. Re-export the mesh with normals.",
            False,
        )

    source = load_source(Path(str(p["imagePath"])))
    texture = bake_projected_texture(
        mesh.positions, mesh.normals, mesh.uvs, mesh.indices, source, size
    )
    validate_texture(texture)
    emit.progress("project", 2, 3)

    # geometry is written back verbatim - the backend owns the shape
    validate_mesh(mesh.positions, mesh.normals, mesh.uvs, mesh.indices)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = (out_dir / OUTPUT_NAME).resolve()
    out_path.write_bytes(
        build_glb(
            positions=mesh.positions,
            normals=mesh.normals,
            uvs=mesh.uvs,
            indices=mesh.indices,
            texture_png=encode_png(texture),
            generator=f"spritebook-texture-substage@{TEXTURE_SUBSTAGE_VERSION}",
        )
    )
    written = verify_written_glb(
        out_path,
        expect_vertices=mesh.vertex_count,
        expect_indices=int(mesh.indices.size),
        expect_texture=True,
    )
    if not np.array_equal(written.positions, mesh.positions):
        raise AdapterError(
            "invalid-output",
            "Vertex positions changed while attaching a texture; the substage must never "
            "alter geometry.",
            False,
        )
    emit.progress("encode", 3, 3)
    emit.artifact("texture", str(out_path))


ADAPTER = Adapter(
    id="texture-substage",
    kind="gen3d",
    version=TEXTURE_SUBSTAGE_VERSION,
    params_schema=PARAMS_SCHEMA,
    defaults=DEFAULTS,
    run=run,
    description=(
        "Projects the cut-out source onto a geometry-only backend's existing UVs, "
        "leaving every vertex untouched."
    ),
)
