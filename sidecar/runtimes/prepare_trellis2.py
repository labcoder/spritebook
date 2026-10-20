"""Adapt three hash-pinned MIT source files; no model or sampling changes."""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path


def read(root: Path, name: str, expected: str) -> str:
    data = (root / name).read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"Unexpected TRELLIS.2 source: {name}")
    return data.decode("utf-8")


def replace(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise ValueError(f"Expected exactly one source boundary: {old}")
    return text.replace(old, new)


def prepare(root: Path) -> None:
    decoder = "trellis2/models/sc_vaes/fdg_vae.py"
    texturing = "trellis2/pipelines/trellis2_texturing.py"
    export = "o-voxel/o_voxel/postprocess.py"
    a = read(root, decoder, "9e082e783ae86174ca2671ae33b6a1134a980fcbea8f168fa35a6800d19eebcb")
    b = read(root, texturing, "100d9b91aea42e235dd19c20a59abdfd526378ca1dea13a8c7b528c8db4cdfe3")
    c = read(root, export, "ef51a1ba0f2748ffb4c265b47d382cee956f23c6a52d0f3587e6d8beccb7e54a")
    a = replace(a, "from o_voxel.convert import", "from o_voxel_vb_ap.convert import")
    b = replace(b, "import o_voxel\n", "import o_voxel_vb_ap as o_voxel\n")
    helper = "from spritebook_sidecar.adapters.trellis2_uv import rasterize_uv"
    b = replace(b, "import nvdiffrast.torch as dr", helper)
    c = replace(c, "import nvdiffrast.torch as dr", helper)
    start, end = b.index("        # rasterize\n"), b.index("        attrs = torch.zeros(")
    b = b[:start] + "        mask, valid_pos = rasterize_uv(vertices_torch, faces_torch, uvs_torch, texture_size)\n\n" + b[end:]
    b = replace(b, "pos[mask]", "valid_pos")
    start = c.index("    # Setup differentiable rasterizer context\n")
    end = c.index("    # Map these positions back")
    c = c[:start] + "    mask, valid_pos = rasterize_uv(out_vertices, out_faces, out_uvs, texture_size)\n\n" + c[end:]
    for name, text in ((decoder, a), (texturing, b), ("trellis2/_spritebook_export.py", c)):
        compile(text, name, "exec")
        (root / name).write_text(text, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    prepare(Path(sys.argv[1]).resolve())
