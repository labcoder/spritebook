"""glTF 2.0 binary container (.glb) — read and write, by hand, in one place.

The container is the fiddly part of the generation path, so both directions
live here with the layout in view:

    12-byte header   magic 'glTF' (0x46546C67 LE), version 2 (u32), total length (u32)
    chunk 0 (JSON)   u32 byteLength, u32 type 0x4E4F534A ('JSON'), payload padded
                     to 4 bytes with SPACES (0x20)
    chunk 1 (BIN)    u32 byteLength, u32 type 0x004E4942 ('BIN\\0'), payload padded
                     to 4 bytes with ZEROS

Every integer is little-endian, every chunk payload is 4-byte aligned, and
`total length` counts the 12-byte header AND both 8-byte chunk headers. The
padding filler differs per chunk on purpose (the JSON chunk must stay parseable
as text, the BIN chunk must not shift accessor offsets), and
``buffers[0].byteLength`` has to cover the padded BIN payload. Get any of those
wrong and most viewers still open the file while glTF-Validator rejects it —
precisely the "ran, but wrong" class this module exists to foreclose.

Determinism is a contract here, not a nicety: gen.ts pins provenance to bytes
(``gltfSha256``), and the same (image, seed, params) must produce a byte-identical
raw.glb. So the JSON object is built in a fixed key order, floats reach it only
through ``float()`` on numpy scalars (shortest-repr, stable), and nothing in this
module consults the clock, a hash seed, or an unseeded RNG.

This module is also home to the output validators both gen3d adapters run before
they emit an artifact — the sidecar-vram law, "an adapter without output
validation is not done". A kernel (or an indexing bug) that quietly produces NaN
geometry exits 0 and looks exactly like success from the outside; only a census
makes it loud.
"""

from __future__ import annotations

import base64
import json
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .adapters import AdapterError

# --- container constants ------------------------------------------------------

GLB_MAGIC = 0x46546C67  # b'glTF'
GLB_VERSION = 2
CHUNK_TYPE_JSON = 0x4E4F534A  # b'JSON'
CHUNK_TYPE_BIN = 0x004E4942  # b'BIN\0'

_HEADER = struct.Struct("<III")  # magic, version, total length
_CHUNK_HEADER = struct.Struct("<II")  # byteLength, chunkType

#: glTF componentType -> numpy dtype (explicitly little-endian; glTF is LE-only).
COMPONENT_TYPES: dict[int, np.dtype] = {
    5120: np.dtype("<i1"),
    5121: np.dtype("<u1"),
    5122: np.dtype("<i2"),
    5123: np.dtype("<u2"),
    5125: np.dtype("<u4"),
    5126: np.dtype("<f4"),
}
#: the reverse, for the component types we WRITE
COMPONENT_CODES: dict[str, int] = {"<u2": 5123, "<u4": 5125, "<f4": 5126}

TYPE_COMPONENTS: dict[str, int] = {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
    "MAT2": 4,
    "MAT3": 9,
    "MAT4": 16,
}
_COMPONENTS_TYPE = {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}

MODE_TRIANGLES = 4
TARGET_ARRAY_BUFFER = 34962
TARGET_ELEMENT_ARRAY_BUFFER = 34963

# --- validator tuning ---------------------------------------------------------

#: fraction of triangles allowed to be zero-area/repeated-index before the mesh
#: is called garbage. A correct UV-sphere emits none (pole quads are emitted as
#: single triangles); a little slack survives float32 rounding on thin features.
MAX_DEGENERATE_FRACTION = 0.10
#: UVs outside this band are not "tiled", they are a units/indexing bug.
UV_SANE_BAND = 16.0


def _pad4(n: int) -> int:
    """Bytes to add to reach the next 4-byte boundary."""
    return (4 - (n % 4)) % 4


# --- reading ------------------------------------------------------------------


@dataclass(frozen=True)
class GlbMesh:
    """One triangle primitive lifted out of a .glb, plus the doc it came from.

    ``indices`` keeps its ON-DISK dtype so a re-write can reproduce the same
    bytes; ``positions``/``normals``/``uvs`` are float32 (N,3)/(N,3)/(N,2).
    """

    positions: np.ndarray
    normals: np.ndarray | None
    uvs: np.ndarray | None
    indices: np.ndarray
    doc: dict[str, Any]
    generator: str
    has_base_color_texture: bool

    @property
    def vertex_count(self) -> int:
        return int(self.positions.shape[0])

    @property
    def triangle_count(self) -> int:
        return int(self.indices.size // 3)


def parse_glb_chunks(raw: bytes) -> tuple[dict[str, Any], bytes]:
    """Split .glb bytes into (JSON doc, BIN payload), checking every length.

    Raises AdapterError('glb-invalid') naming what disagreed — a truncated or
    mis-padded container is the failure this function exists to catch, so it is
    never allowed to surface as a struct.error traceback.
    """
    if len(raw) < _HEADER.size:
        raise AdapterError(
            "glb-invalid",
            f"File is {len(raw)} bytes; a glb needs at least a 12-byte header.",
            False,
        )
    magic, version, total = _HEADER.unpack_from(raw, 0)
    if magic != GLB_MAGIC:
        raise AdapterError(
            "glb-invalid",
            f"Bad glb magic 0x{magic:08X}; expected 0x{GLB_MAGIC:08X} ('glTF'). "
            "This is not a binary glTF file (a .gltf JSON file is a different format).",
            False,
        )
    if version != GLB_VERSION:
        raise AdapterError(
            "glb-invalid", f"glb container version {version}; only version 2 is supported.", False
        )
    if total != len(raw):
        raise AdapterError(
            "glb-invalid",
            f"Header declares {total} bytes but the file is {len(raw)} bytes.",
            False,
        )

    doc: dict[str, Any] | None = None
    blob = b""
    offset = _HEADER.size
    seen_json = False
    while offset + _CHUNK_HEADER.size <= total:
        length, ctype = _CHUNK_HEADER.unpack_from(raw, offset)
        offset += _CHUNK_HEADER.size
        if offset + length > total:
            raise AdapterError(
                "glb-invalid",
                f"Chunk at offset {offset} declares {length} bytes, past the {total}-byte file end.",
                False,
            )
        payload = raw[offset : offset + length]
        offset += length + _pad4(length)
        if ctype == CHUNK_TYPE_JSON:
            if seen_json:
                raise AdapterError("glb-invalid", "More than one JSON chunk.", False)
            seen_json = True
            try:
                parsed = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise AdapterError(
                    "glb-invalid", f"JSON chunk does not parse: {exc}", False
                ) from exc
            if not isinstance(parsed, dict):
                raise AdapterError("glb-invalid", "JSON chunk is not an object.", False)
            doc = parsed
        elif ctype == CHUNK_TYPE_BIN:
            blob = payload
        # unknown chunk types are skipped by spec

    if doc is None:
        raise AdapterError("glb-invalid", "No JSON chunk in the glb container.", False)
    return doc, blob


def _resolve_buffers(doc: dict[str, Any], blob: bytes) -> list[bytes]:
    """buffers[] -> raw bytes. Buffer 0 is the BIN chunk; ``data:`` URIs are
    decoded; an external file URI is an actionable refusal (SpriteBook keeps
    generation output self-contained — a sidecar glb with a sibling .bin would
    break the moment the border copies it)."""
    out: list[bytes] = []
    for i, buf in enumerate(doc.get("buffers", [])):
        uri = buf.get("uri")
        if uri is None:
            out.append(blob)
        elif isinstance(uri, str) and uri.startswith("data:"):
            _, _, b64 = uri.partition(",")
            try:
                out.append(base64.b64decode(b64))
            except Exception as exc:  # noqa: BLE001 - malformed base64 of any kind
                raise AdapterError(
                    "glb-invalid", f"buffers[{i}] data: URI does not decode: {exc}", False
                ) from exc
        else:
            raise AdapterError(
                "external-buffer",
                f"buffers[{i}] points at an external file ('{uri}'). Only self-contained "
                "glb files are supported; re-export with the buffer embedded.",
                False,
            )
    return out


def _read_accessor(doc: dict[str, Any], buffers: list[bytes], index: int) -> np.ndarray:
    """Accessor -> (count, ncomp) array, honoring byteOffset and byteStride.

    Interleaved vertex buffers (a nonzero ``byteStride``) are normal output from
    real exporters, so the strided gather is not optional.
    """
    try:
        acc = doc["accessors"][index]
    except (KeyError, IndexError) as exc:
        raise AdapterError("glb-invalid", f"accessors[{index}] missing.", False) from exc
    if "sparse" in acc:
        raise AdapterError(
            "unsupported-glb",
            f"accessors[{index}] is sparse; sparse accessors are not supported. "
            "Re-export the mesh with dense accessors.",
            False,
        )
    comp_code = int(acc.get("componentType", -1))
    dtype = COMPONENT_TYPES.get(comp_code)
    if dtype is None:
        raise AdapterError(
            "glb-invalid", f"accessors[{index}] has unknown componentType {comp_code}.", False
        )
    acc_type = str(acc.get("type", ""))
    ncomp = TYPE_COMPONENTS.get(acc_type)
    if ncomp is None:
        raise AdapterError(
            "glb-invalid", f"accessors[{index}] has unknown type '{acc_type}'.", False
        )
    count = int(acc.get("count", 0))
    if count < 0:
        raise AdapterError("glb-invalid", f"accessors[{index}] has count {count}.", False)

    # Spec: an accessor with no bufferView reads as all zeros.
    if "bufferView" not in acc:
        return np.zeros((count, ncomp), dtype=dtype)

    try:
        bv = doc["bufferViews"][int(acc["bufferView"])]
    except (KeyError, IndexError, TypeError) as exc:
        raise AdapterError(
            "glb-invalid", f"accessors[{index}] references a missing bufferView.", False
        ) from exc
    buf_index = int(bv.get("buffer", 0))
    if buf_index >= len(buffers):
        raise AdapterError(
            "glb-invalid", f"bufferViews references missing buffers[{buf_index}].", False
        )
    blob = buffers[buf_index]
    base = int(bv.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
    item = dtype.itemsize * ncomp
    stride = int(bv.get("byteStride", 0)) or item
    needed = base + (stride * (count - 1) + item if count else 0)
    if needed > len(blob):
        raise AdapterError(
            "glb-invalid",
            f"accessors[{index}] reads {needed} bytes from a {len(blob)}-byte buffer.",
            False,
        )
    if count == 0:
        return np.zeros((0, ncomp), dtype=dtype)

    if stride == item:
        flat = np.frombuffer(blob, dtype=dtype, count=count * ncomp, offset=base)
        return flat.reshape(count, ncomp).copy()
    # Interleaved: gather item-sized rows out of a stride-spaced byte view.
    raw = np.frombuffer(blob, dtype=np.uint8, count=stride * (count - 1) + item, offset=base)
    view = np.lib.stride_tricks.as_strided(raw, shape=(count, item), strides=(stride, 1))
    return view.copy().view(dtype).reshape(count, ncomp)


def _primitive(doc: dict[str, Any]) -> dict[str, Any]:
    """The single triangle primitive we operate on, or an actionable refusal."""
    meshes = doc.get("meshes") or []
    if len(meshes) != 1:
        raise AdapterError(
            "unsupported-glb",
            f"glb has {len(meshes)} meshes; the texture substage handles exactly one. "
            "Join the mesh into a single primitive before texturing.",
            False,
        )
    prims = meshes[0].get("primitives") or []
    if len(prims) != 1:
        raise AdapterError(
            "unsupported-glb",
            f"mesh has {len(prims)} primitives; the texture substage handles exactly one "
            "(one primitive means one material, which is what a single baked texture can cover). "
            "Join the primitives before texturing.",
            False,
        )
    prim = prims[0]
    mode = int(prim.get("mode", MODE_TRIANGLES))
    if mode != MODE_TRIANGLES:
        raise AdapterError(
            "unsupported-glb",
            f"primitive mode is {mode}; only TRIANGLES (4) is supported.",
            False,
        )
    return prim


def read_glb(path: Path) -> GlbMesh:
    """Load a single-primitive triangle mesh out of a .glb file."""
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        raise AdapterError("input-missing", f"Cannot read '{path}': {exc}", False) from exc

    doc, blob = parse_glb_chunks(raw)
    buffers = _resolve_buffers(doc, blob)
    prim = _primitive(doc)
    attrs = prim.get("attributes") or {}
    if "POSITION" not in attrs:
        raise AdapterError(
            "glb-invalid", "primitive has no POSITION attribute; there is no geometry to texture.", False
        )

    positions = _read_accessor(doc, buffers, int(attrs["POSITION"])).astype(np.float32, copy=False)
    if positions.shape[1] != 3:
        raise AdapterError(
            "glb-invalid", f"POSITION is {positions.shape[1]}-component; expected VEC3.", False
        )
    normals = None
    if "NORMAL" in attrs:
        normals = _read_accessor(doc, buffers, int(attrs["NORMAL"])).astype(np.float32, copy=False)
    uvs = None
    if "TEXCOORD_0" in attrs:
        uvs = _read_accessor(doc, buffers, int(attrs["TEXCOORD_0"])).astype(np.float32, copy=False)

    if "indices" in prim:
        indices = _read_accessor(doc, buffers, int(prim["indices"])).reshape(-1)
    else:
        # Non-indexed draw: the vertex order IS the triangle list.
        indices = np.arange(positions.shape[0], dtype=np.uint32)

    has_tex = False
    mat_index = prim.get("material")
    if mat_index is not None:
        try:
            mat = doc["materials"][int(mat_index)]
            has_tex = "baseColorTexture" in (mat.get("pbrMetallicRoughness") or {})
        except (KeyError, IndexError, TypeError):
            has_tex = False

    generator = str((doc.get("asset") or {}).get("generator", ""))
    return GlbMesh(
        positions=positions,
        normals=normals,
        uvs=uvs,
        indices=indices,
        doc=doc,
        generator=generator,
        has_base_color_texture=has_tex,
    )


# --- whole-scene geometry (the rig path) --------------------------------------


@dataclass(frozen=True)
class ScenePrimitive:
    """Where one primitive's vertices landed in the flattened scene arrays."""

    node: int
    mesh: int
    primitive: int
    first_vertex: int
    vertex_count: int


@dataclass(frozen=True)
class SceneGeometry:
    """Every triangle primitive of a glb's default scene, flattened and posed.

    :func:`read_glb` deliberately handles exactly one mesh with one primitive —
    that is all the generation path ever writes, and refusing anything else
    there keeps the texture substage honest. Rigging has no such luxury: the
    border does not join meshes, so a canonical character routinely arrives as
    several meshes under several nodes (the P0-T4 humanoid is body + eyes +
    eyebrows). A rig has to cover all of it.

    ``positions`` is therefore the concatenation of every triangle primitive
    reachable from the default scene, each transformed by its NODE'S WORLD
    MATRIX, in this order:

        scene.nodes in order -> depth-first, children in order
          -> for a node with a mesh, primitives in order

    That order IS the contract between this adapter's ``rig.npz`` rows and the
    mesh core applies them to; ``primitives`` records the span each one
    occupies so a consumer can prove its own traversal agrees rather than
    assume it.
    """

    positions: np.ndarray  # (N, 3) float32, world space
    triangles: np.ndarray  # (M, 3) int64, indices into positions
    primitives: list[ScenePrimitive]
    has_skins: bool

    @property
    def vertex_count(self) -> int:
        return int(self.positions.shape[0])


def _node_matrix(node: dict[str, Any]) -> np.ndarray:
    """One node's local transform as a 4x4, from ``matrix`` or from TRS."""
    if "matrix" in node:
        m = np.asarray(node["matrix"], dtype=np.float64)
        if m.size != 16:
            raise AdapterError(
                "glb-invalid", f"node.matrix has {m.size} elements; expected 16.", False
            )
        # glTF matrices are COLUMN-major; numpy reads row-major, so transpose.
        return m.reshape(4, 4).T
    out = np.eye(4, dtype=np.float64)
    t = np.asarray(node.get("translation", (0.0, 0.0, 0.0)), dtype=np.float64)
    s = np.asarray(node.get("scale", (1.0, 1.0, 1.0)), dtype=np.float64)
    x, y, z, w = (float(v) for v in node.get("rotation", (0.0, 0.0, 0.0, 1.0)))
    rot = np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ],
        dtype=np.float64,
    )
    out[:3, :3] = rot @ np.diag(s)
    out[:3, 3] = t
    return out


def read_scene_geometry(path: Path) -> SceneGeometry:
    """Flatten a glb's default scene into one posed vertex + triangle array.

    Raises AdapterError naming the offending primitive for anything that cannot
    be rigged as a triangle mesh — a silently skipped primitive is a region of
    the character that would come back unweighted with no explanation.
    """
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        raise AdapterError("input-missing", f"Cannot read '{path}': {exc}", False) from exc

    doc, blob = parse_glb_chunks(raw)
    buffers = _resolve_buffers(doc, blob)
    nodes: list[dict[str, Any]] = doc.get("nodes") or []
    meshes: list[dict[str, Any]] = doc.get("meshes") or []
    scenes: list[dict[str, Any]] = doc.get("scenes") or []
    scene_index = int(doc.get("scene", 0))
    if not scenes:
        raise AdapterError("glb-invalid", "glb declares no scenes; there is nothing to rig.", False)
    if scene_index >= len(scenes):
        raise AdapterError(
            "glb-invalid", f"asset.scene is {scene_index} but only {len(scenes)} scenes exist.", False
        )

    pos_chunks: list[np.ndarray] = []
    tri_chunks: list[np.ndarray] = []
    spans: list[ScenePrimitive] = []
    total = 0

    def visit(node_index: int, parent: np.ndarray, seen: frozenset[int]) -> None:
        nonlocal total
        if node_index in seen:
            raise AdapterError(
                "glb-invalid", f"node {node_index} is its own ancestor; the scene graph is cyclic.", False
            )
        if node_index >= len(nodes):
            raise AdapterError(
                "glb-invalid", f"scene references node {node_index}; only {len(nodes)} exist.", False
            )
        node = nodes[node_index]
        world = parent @ _node_matrix(node)
        mesh_index = node.get("mesh")
        if mesh_index is not None:
            mi = int(mesh_index)
            if mi >= len(meshes):
                raise AdapterError(
                    "glb-invalid", f"node {node_index} references mesh {mi}; only {len(meshes)} exist.", False
                )
            for pi, prim in enumerate(meshes[mi].get("primitives") or []):
                mode = int(prim.get("mode", MODE_TRIANGLES))
                if mode != MODE_TRIANGLES:
                    raise AdapterError(
                        "unsupported-glb",
                        f"meshes[{mi}].primitives[{pi}] has mode {mode}; only TRIANGLES (4) can "
                        "be rigged. Re-export the character as triangle meshes.",
                        False,
                    )
                attrs = prim.get("attributes") or {}
                if "POSITION" not in attrs:
                    raise AdapterError(
                        "glb-invalid",
                        f"meshes[{mi}].primitives[{pi}] has no POSITION attribute.",
                        False,
                    )
                local = _read_accessor(doc, buffers, int(attrs["POSITION"])).astype(np.float64)
                if local.ndim != 2 or local.shape[1] != 3:
                    raise AdapterError(
                        "glb-invalid",
                        f"meshes[{mi}].primitives[{pi}] POSITION is not VEC3.",
                        False,
                    )
                posed = local @ world[:3, :3].T + world[:3, 3]
                if "indices" in prim:
                    idx = _read_accessor(doc, buffers, int(prim["indices"])).reshape(-1)
                else:
                    idx = np.arange(local.shape[0], dtype=np.int64)
                idx = np.asarray(idx, dtype=np.int64)
                if idx.size % 3 != 0:
                    raise AdapterError(
                        "glb-invalid",
                        f"meshes[{mi}].primitives[{pi}] has {idx.size} indices, not a multiple of 3.",
                        False,
                    )
                if idx.size and (int(idx.min()) < 0 or int(idx.max()) >= local.shape[0]):
                    raise AdapterError(
                        "index-out-of-range",
                        f"meshes[{mi}].primitives[{pi}] indices span "
                        f"[{int(idx.min())}, {int(idx.max())}] over {local.shape[0]} vertices.",
                        False,
                    )
                pos_chunks.append(posed.astype(np.float32))
                tri_chunks.append(idx.reshape(-1, 3) + total)
                spans.append(
                    ScenePrimitive(
                        node=node_index,
                        mesh=mi,
                        primitive=pi,
                        first_vertex=total,
                        vertex_count=int(local.shape[0]),
                    )
                )
                total += int(local.shape[0])
        child_seen = seen | {node_index}
        for child in node.get("children") or []:
            visit(int(child), world, child_seen)

    for root in scenes[scene_index].get("nodes") or []:
        visit(int(root), np.eye(4, dtype=np.float64), frozenset())

    if not pos_chunks:
        raise AdapterError(
            "glb-invalid",
            f"'{path}' default scene contains no triangle geometry; there is nothing to rig.",
            False,
        )
    positions = np.concatenate(pos_chunks, axis=0)
    triangles = np.concatenate(tri_chunks, axis=0)
    report, bad = _nonfinite_census("positions", positions)
    if bad:
        raise AdapterError(
            "invalid-output", f"Input mesh has non-finite vertex positions ({report}).", False
        )
    return SceneGeometry(
        positions=positions,
        triangles=triangles,
        primitives=spans,
        has_skins=bool(doc.get("skins")),
    )


# --- writing ------------------------------------------------------------------


def _index_dtype(indices: np.ndarray) -> np.dtype:
    """Narrowest legal glTF index type for these values (deterministic)."""
    if indices.dtype in (np.dtype("<u2"), np.dtype("<u4")):
        return indices.dtype  # preserve the on-disk type of a mesh we read back
    return np.dtype("<u2") if int(indices.max(initial=0)) < 65536 else np.dtype("<u4")


def build_glb(
    *,
    positions: np.ndarray,
    normals: np.ndarray,
    uvs: np.ndarray,
    indices: np.ndarray,
    texture_png: bytes,
    generator: str,
) -> bytes:
    """Serialize one textured triangle mesh into .glb bytes.

    Arrays are written verbatim (float32 positions/normals/uvs), so a caller
    that read them out of another glb gets its geometry back bit-for-bit. The
    PNG is embedded in the BIN chunk — never an external file, because the
    border copies the glb alone.
    """
    pos = np.ascontiguousarray(positions, dtype="<f4")
    nrm = np.ascontiguousarray(normals, dtype="<f4")
    uv = np.ascontiguousarray(uvs, dtype="<f4")
    idx = np.ascontiguousarray(indices, dtype=_index_dtype(indices)).reshape(-1)
    if pos.ndim != 2 or pos.shape[1] != 3:
        raise ValueError(f"positions must be (N,3), got {pos.shape}")
    if nrm.shape != pos.shape:
        raise ValueError(f"normals {nrm.shape} must match positions {pos.shape}")
    if uv.ndim != 2 or uv.shape != (pos.shape[0], 2):
        raise ValueError(f"uvs must be (N,2) matching positions, got {uv.shape}")

    # BIN layout: each section 4-byte aligned so every accessor offset is legal
    # for its component size (glTF requires accessor offsets to be a multiple of
    # the component size, and float32/uint32 both want 4).
    sections = [pos.tobytes(), nrm.tobytes(), uv.tobytes(), idx.tobytes(), texture_png]
    blob = bytearray()
    offsets: list[int] = []
    for section in sections:
        offsets.append(len(blob))
        blob.extend(section)
        blob.extend(b"\x00" * _pad4(len(section)))

    pmin = pos.min(axis=0)
    pmax = pos.max(axis=0)

    doc: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": generator},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [
            {
                "primitives": [
                    {
                        "attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2},
                        "indices": 3,
                        "material": 0,
                        "mode": MODE_TRIANGLES,
                    }
                ]
            }
        ],
        "materials": [
            {
                "name": "spritebook-basecolor",
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": 0, "texCoord": 0},
                    "metallicFactor": 0.0,
                    "roughnessFactor": 1.0,
                },
                "doubleSided": False,
            }
        ],
        "textures": [{"sampler": 0, "source": 0}],
        "samplers": [
            {"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}
        ],
        "images": [{"bufferView": 4, "mimeType": "image/png"}],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": COMPONENT_CODES["<f4"],
                "count": int(pos.shape[0]),
                "type": "VEC3",
                # glTF REQUIRES min/max on POSITION (culling and bounds depend
                # on it); float() keeps the JSON stable across runs.
                "min": [float(pmin[0]), float(pmin[1]), float(pmin[2])],
                "max": [float(pmax[0]), float(pmax[1]), float(pmax[2])],
            },
            {
                "bufferView": 1,
                "componentType": COMPONENT_CODES["<f4"],
                "count": int(nrm.shape[0]),
                "type": "VEC3",
            },
            {
                "bufferView": 2,
                "componentType": COMPONENT_CODES["<f4"],
                "count": int(uv.shape[0]),
                "type": "VEC2",
            },
            {
                "bufferView": 3,
                "componentType": COMPONENT_CODES[idx.dtype.str],
                "count": int(idx.size),
                "type": "SCALAR",
            },
        ],
        "bufferViews": [
            {
                "buffer": 0,
                "byteOffset": offsets[0],
                "byteLength": len(sections[0]),
                "target": TARGET_ARRAY_BUFFER,
            },
            {
                "buffer": 0,
                "byteOffset": offsets[1],
                "byteLength": len(sections[1]),
                "target": TARGET_ARRAY_BUFFER,
            },
            {
                "buffer": 0,
                "byteOffset": offsets[2],
                "byteLength": len(sections[2]),
                "target": TARGET_ARRAY_BUFFER,
            },
            {
                "buffer": 0,
                "byteOffset": offsets[3],
                "byteLength": len(sections[3]),
                "target": TARGET_ELEMENT_ARRAY_BUFFER,
            },
            # An image bufferView must NOT declare a target.
            {"buffer": 0, "byteOffset": offsets[4], "byteLength": len(sections[4])},
        ],
        "buffers": [{"byteLength": len(blob)}],
    }

    json_bytes = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_bytes += b" " * _pad4(len(json_bytes))  # JSON chunk pads with SPACES
    bin_bytes = bytes(blob)  # already 4-aligned; BIN chunk pads with ZEROS

    total = _HEADER.size + _CHUNK_HEADER.size * 2 + len(json_bytes) + len(bin_bytes)
    out = bytearray()
    out.extend(_HEADER.pack(GLB_MAGIC, GLB_VERSION, total))
    out.extend(_CHUNK_HEADER.pack(len(json_bytes), CHUNK_TYPE_JSON))
    out.extend(json_bytes)
    out.extend(_CHUNK_HEADER.pack(len(bin_bytes), CHUNK_TYPE_BIN))
    out.extend(bin_bytes)
    return bytes(out)


def write_glb(path: Path, **kwargs: Any) -> bytes:
    """:func:`build_glb` straight to disk; returns the bytes written."""
    data = build_glb(**kwargs)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


# --- output validation (sidecar-vram law) -------------------------------------


def _nonfinite_census(name: str, arr: np.ndarray) -> tuple[str, int]:
    a = np.asarray(arr, dtype=np.float64)
    nans = int(np.isnan(a).sum())
    infs = int(np.isinf(a).sum())
    if nans or infs:
        return f"{name}: {nans} NaN, {infs} Inf of {a.size} values", nans + infs
    return "", 0


def validate_mesh(
    positions: np.ndarray,
    normals: np.ndarray,
    uvs: np.ndarray,
    indices: np.ndarray,
    *,
    max_degenerate_fraction: float = MAX_DEGENERATE_FRACTION,
) -> dict[str, Any]:
    """Numeric census over a mesh about to be written. Returns stats; raises.

    A CUDA kernel fault, a bad reduction, or an off-by-one in an index buffer
    all exit 0 and produce a file. These are the checks that tell the three
    apart from success (P0-T4: all-NaN skin weights, exit code 0).
    """
    n_verts = int(positions.shape[0])
    if n_verts == 0:
        raise AdapterError("invalid-output", "Mesh has 0 vertices.", False)
    if indices.size == 0:
        raise AdapterError("invalid-output", "Mesh has 0 indices.", False)
    if indices.size % 3 != 0:
        raise AdapterError(
            "invalid-output",
            f"Index count {indices.size} is not a multiple of 3; the mesh is not a triangle list.",
            False,
        )

    # 1. NaN/Inf census, naming the counts.
    reports: list[str] = []
    total_bad = 0
    for name, arr in (("positions", positions), ("normals", normals), ("uvs", uvs)):
        report, bad = _nonfinite_census(name, arr)
        if bad:
            reports.append(report)
            total_bad += bad
    if total_bad:
        raise AdapterError(
            "invalid-output",
            "Non-finite values in the generated mesh (" + "; ".join(reports) + "). "
            "This is the silent-GPU-failure signature: the stage exited cleanly and "
            "produced garbage. Re-run with a different seed; if it repeats, the backend is at fault.",
            False,
        )

    # 2. Index bounds — an out-of-range index is a crash in every consumer downstream.
    idx_min = int(indices.min())
    idx_max = int(indices.max())
    if idx_min < 0 or idx_max >= n_verts:
        raise AdapterError(
            "index-out-of-range",
            f"Indices span [{idx_min}, {idx_max}] but the mesh has {n_verts} vertices.",
            False,
        )

    # 3. Degenerate triangles: zero area, or a repeated vertex inside a triangle.
    tri = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    p = np.asarray(positions, dtype=np.float64)
    e1 = p[tri[:, 1]] - p[tri[:, 0]]
    e2 = p[tri[:, 2]] - p[tri[:, 0]]
    areas = 0.5 * np.linalg.norm(np.cross(e1, e2), axis=1)
    diag = float(np.linalg.norm(p.max(axis=0) - p.min(axis=0)))
    area_eps = max((1e-6 * diag) ** 2, 1e-20)
    repeated = (
        (tri[:, 0] == tri[:, 1]) | (tri[:, 1] == tri[:, 2]) | (tri[:, 0] == tri[:, 2])
    )
    degenerate = repeated | (areas <= area_eps)
    n_tris = int(tri.shape[0])
    n_degenerate = int(degenerate.sum())
    frac = n_degenerate / n_tris
    if frac > max_degenerate_fraction:
        raise AdapterError(
            "degenerate-mesh",
            f"{n_degenerate} of {n_tris} triangles ({frac * 100:.1f}%) are degenerate "
            f"(zero-area or repeated indices), above the {max_degenerate_fraction * 100:.0f}% "
            "tolerance. The mesh collapsed rather than generated.",
            False,
        )

    # 4. UV sanity: finite (covered above) and inside a band a real unwrap lives in.
    uv_min = float(np.min(uvs)) if uvs.size else 0.0
    uv_max = float(np.max(uvs)) if uvs.size else 0.0
    if uv_min < -UV_SANE_BAND or uv_max > UV_SANE_BAND:
        raise AdapterError(
            "invalid-uv",
            f"UVs span [{uv_min:.3g}, {uv_max:.3g}], outside the sane band "
            f"[-{UV_SANE_BAND:g}, {UV_SANE_BAND:g}]. That is a units or indexing bug, not tiling.",
            False,
        )

    return {
        "vertices": n_verts,
        "triangles": n_tris,
        "degenerate": n_degenerate,
        "degenerateFraction": frac,
        "uvMin": uv_min,
        "uvMax": uv_max,
        "bboxDiagonal": diag,
    }


def validate_texture(rgb: np.ndarray) -> dict[str, Any]:
    """Census over the baked texture before it is embedded.

    A projection that silently sampled nothing yields a uniform (usually black)
    image, and a uniform texture is indistinguishable from that failure — so it
    is refused, with a message that says exactly which honest input also lands
    here (an all-black subject).
    """
    if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.shape[0] < 1 or rgb.shape[1] < 1:
        raise AdapterError(
            "invalid-output", f"Texture has shape {rgb.shape}; expected (H, W, 3).", False
        )
    a = np.asarray(rgb, dtype=np.float64)
    report, bad = _nonfinite_census("texture", a)
    if bad:
        raise AdapterError("invalid-output", f"Non-finite values in the texture ({report}).", False)
    spread = float(a.max() - a.min())
    if spread == 0.0:
        raise AdapterError(
            "flat-texture",
            f"The baked texture is a single uniform value ({float(a.min()):.0f}); the "
            "projection sampled nothing from the source. If the source subject really is "
            "one flat color with no shading, it cannot be told apart from a failed "
            "projection — use a source with visible tone variation.",
            False,
        )
    return {
        "width": int(rgb.shape[1]),
        "height": int(rgb.shape[0]),
        "min": float(a.min()),
        "max": float(a.max()),
        "spread": spread,
    }


def verify_written_glb(
    path: Path, *, expect_vertices: int, expect_indices: int, expect_texture: bool = True
) -> GlbMesh:
    """Re-read what we just wrote and prove it survives the round trip.

    Artifact validation over exit codes (sidecar-vram): the writer "succeeding"
    means nothing until a reader agrees, so the adapter reads its own output back
    before it emits the artifact event.
    """
    mesh = read_glb(path)
    if mesh.vertex_count != expect_vertices:
        raise AdapterError(
            "glb-invalid",
            f"Wrote {expect_vertices} vertices but read back {mesh.vertex_count}.",
            False,
        )
    if int(mesh.indices.size) != expect_indices:
        raise AdapterError(
            "glb-invalid",
            f"Wrote {expect_indices} indices but read back {int(mesh.indices.size)}.",
            False,
        )
    if mesh.uvs is None:
        raise AdapterError("glb-invalid", "Re-read glb has no TEXCOORD_0.", False)
    if expect_texture and not mesh.has_base_color_texture:
        raise AdapterError(
            "glb-invalid", "Re-read glb has no material baseColorTexture.", False
        )
    pos_acc = mesh.doc["accessors"][0]
    if "min" not in pos_acc or "max" not in pos_acc:
        raise AdapterError(
            "glb-invalid", "Re-read glb POSITION accessor is missing min/max.", False
        )
    return mesh
