"""Deterministic GPU-free `retexture` stand-in.

The counterpart to `fixture-gen`, and it exists for the same reason: the
retexture VERB - capability resolution, the sidecar call, the border, a receipt
naming its parent - must be provable on a machine with no GPU and no 16 GB
download. Without it the only proof of that path would need an RTX 3090.

It keeps the input mesh EXACTLY: positions, normals, uvs and the index buffer
are written back unchanged, so "the geometry is untouched" is literally true
here rather than true to a tolerance. Only the texture is new, and it is a
seed-dependent hue rotation of the source so that two seeds visibly differ and
the same seed reproduces.

That difference from the real backend is deliberate and worth naming: TRELLIS.2
re-encodes the mesh and hands back the same SURFACE with a different vertex
buffer (~1.5% more vertices, faces reordered), while this hands back the same
buffer. So a test written against this adapter can assert more than the feature
promises, and `retexture_test.ts` says out loud which of its assertions are
fixture-strength and which are the shared contract.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from ..glb import read_glb, validate_texture, verify_written_glb, write_glb
from . import Adapter, AdapterError, Emitter, validate_params
from .fixture_gen import bake_texture, encode_png, load_source
from .trellis2 import GEN_ARTIFACT_MESH, GEN_ARTIFACT_META, META_FILE, RAW_MODEL

FIXTURE_RETEXTURE_VERSION = "0.1.0"

PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["meshPath", "imagePath", "outDir", "seed"],
    "properties": {
        "meshPath": {"type": "string", "minLength": 1},
        "imagePath": {"type": "string", "minLength": 1},
        "outDir": {"type": "string", "minLength": 1},
        # accepted and unused: core sends it for every backend, and refusing it
        # here would make this adapter the odd one out for no benefit
        "modelDir": {"type": "string", "minLength": 1},
        "seed": {"type": "integer", "minimum": 0},
        "textureSize": {"type": "integer", "minimum": 16, "maximum": 4096},
    },
    "additionalProperties": False,
}

DEFAULTS: dict[str, Any] = {"textureSize": 512}


def hue_rotate(rgb: np.ndarray, turns: float) -> np.ndarray:
    """Rotate hue by `turns` of a full circle, in place-safe float space.

    The YIQ rotation matrix rather than a round trip through HSV: one matrix
    multiply, and in float space it moves chroma while leaving luma alone.

    In THIS function it does not, quite: the result is clipped to [0, 255] and
    cast to uint8, which is a lossy step the rotation itself is not. Measured on
    the test's own palette, luma moves by up to 11/255 and a rotate-and-return
    is off by as much as 77/255. That is fine for a fixture whose job is to look
    different per seed and reproduce per seed, but it is not a colour-managed
    transform and nothing should be built on top of it.
    """
    angle = 2.0 * math.pi * turns
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    # ITU-R BT.601 luma weights, then the classic YIQ chroma rotation
    matrix = np.array(
        [
            [
                0.299 + 0.701 * cos_a + 0.168 * sin_a,
                0.587 - 0.587 * cos_a + 0.330 * sin_a,
                0.114 - 0.114 * cos_a - 0.497 * sin_a,
            ],
            [
                0.299 - 0.299 * cos_a - 0.328 * sin_a,
                0.587 + 0.413 * cos_a + 0.035 * sin_a,
                0.114 - 0.114 * cos_a + 0.292 * sin_a,
            ],
            [
                0.299 - 0.300 * cos_a + 1.250 * sin_a,
                0.587 - 0.588 * cos_a - 1.050 * sin_a,
                0.114 + 0.886 * cos_a - 0.203 * sin_a,
            ],
        ],
        dtype=np.float64,
    )
    out = np.asarray(rgb, dtype=np.float64) @ matrix.T
    return np.clip(out, 0.0, 255.0).astype(np.uint8)


def seed_turns(seed: int) -> float:
    """Seed -> hue offset. Distinct for distinct seeds, stable for the same one.

    The golden ratio spreads consecutive seeds far apart, so `--seed 1` and
    `--seed 2` look different rather than nearly identical - which is the whole
    point of rerolling.
    """
    return (seed * 0.6180339887498949) % 1.0


def run(params: dict[str, Any], emit: Emitter) -> None:
    p = validate_params(PARAMS_SCHEMA, params, DEFAULTS)
    mesh_path = Path(str(p["meshPath"]))
    out_dir = Path(str(p["outDir"]))
    seed = int(p["seed"])
    tex_size = int(p["textureSize"])

    mesh = read_glb(mesh_path)
    if mesh.uvs is None:
        raise AdapterError(
            "bad-input",
            f"'{mesh_path}' has no UVs, so there is nowhere to put a texture. Generation "
            f"produces them; a mesh from elsewhere may not have them.",
            False,
        )
    emit.progress("load", 1, 3)

    source = load_source(Path(str(p["imagePath"])))
    texture = hue_rotate(bake_texture(source, tex_size), seed_turns(seed))
    validate_texture(texture)
    emit.progress("texture", 2, 3)

    normals = mesh.normals
    if normals is None:
        # a mesh without normals is legal glTF (flat shading is implied), and
        # inventing smooth ones would change how it renders
        normals = np.zeros_like(mesh.positions)
        normals[:, 1] = 1.0

    out_path = (out_dir / RAW_MODEL).resolve()
    write_glb(
        out_path,
        positions=mesh.positions,
        normals=normals,
        uvs=mesh.uvs,
        indices=mesh.indices,
        texture_png=encode_png(texture),
        generator=(
            f"spritebook-fixture-retexture/{FIXTURE_RETEXTURE_VERSION} "
            f"(seed={seed}; tex={tex_size})"
        ),
    )
    verify_written_glb(
        out_path,
        expect_vertices=mesh.vertex_count,
        expect_indices=int(mesh.indices.size),
        expect_texture=True,
    )
    emit.progress("encode", 3, 3)

    # the same meta shape the real backend writes, so core reads one format
    meta_path = (out_dir / META_FILE).resolve()
    meta_path.write_text(
        json.dumps(
            {
                "adapter": "fixture-retexture",
                "adapterVersion": FIXTURE_RETEXTURE_VERSION,
                "requestedSeed": seed,
                # nothing collapses here, so the ladder never climbs
                "effectiveSeed": seed,
                "seedsTried": [seed],
                "topologyPreserved": True,
                "frameShift": 0.0,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    emit.artifact(GEN_ARTIFACT_META, str(meta_path))
    emit.artifact(GEN_ARTIFACT_MESH, str(out_path))


ADAPTER = Adapter(
    id="fixture-retexture",
    kind="retexture",
    version=FIXTURE_RETEXTURE_VERSION,
    params_schema=PARAMS_SCHEMA,
    defaults=DEFAULTS,
    run=run,
    description=(
        "Deterministic GPU-free retexture stand-in: keeps the input mesh exactly and "
        "repaints it with a seed-dependent hue rotation of the source image."
    ),
)
