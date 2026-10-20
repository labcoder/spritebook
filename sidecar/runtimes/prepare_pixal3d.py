"""Adapt pinned MIT decoder/export boundaries; retain Pixal sampling and NAF."""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path


def read(path: Path, expected: str) -> str:
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"Unexpected Pixal3D runtime source: {path.name}")
    return data.decode("utf-8")


def prepare(root: Path) -> None:
    decoder = root / "pixal3d/models/sc_vaes/fdg_vae.py"
    text = read(decoder, "9e082e783ae86174ca2671ae33b6a1134a980fcbea8f168fa35a6800d19eebcb")
    old = "from o_voxel.convert import"
    if text.count(old) != 1:
        raise ValueError("Expected one O-Voxel import")
    decoder.write_text(text.replace(old, "from o_voxel_vb_ap.convert import"), encoding="utf-8", newline="\n")

    # Reuse the audited TRELLIS exporter, including cleanup, UVs and PBR projection.
    text = read(root.parent / "export/o-voxel/o_voxel/postprocess.py",
                "ef51a1ba0f2748ffb4c265b47d382cee956f23c6a52d0f3587e6d8beccb7e54a")
    text = text.replace("import nvdiffrast.torch as dr",
                        "from spritebook_sidecar.adapters.trellis2_uv import rasterize_uv")
    start = text.index("    # Setup differentiable rasterizer context\n")
    end = text.index("    # Map these positions back")
    text = text[:start] + "    mask, valid_pos = rasterize_uv(out_vertices, out_faces, out_uvs, texture_size)\n\n" + text[end:]
    compile(text, "pixal3d/_spritebook_export.py", "exec")
    (root / "pixal3d/_spritebook_export.py").write_text(text, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    prepare(Path(sys.argv[1]).resolve())
