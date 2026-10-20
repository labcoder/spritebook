"""UV rasterization using DRTK; see notices/uv-rasterizer-MIT.txt for attribution."""
from __future__ import annotations

from typing import Any


def rasterize_uv(vertices: Any, faces: Any, uvs: Any, size: int) -> tuple[Any, Any]:
    import drtk
    import torch

    # DRTK pixel centers are integers. Keep the existing exporter's final UV flip.
    projected = torch.cat((uvs.float() * size - 0.5, torch.ones_like(uvs[:, :1])), dim=1)[None]
    faces = faces.int().contiguous()
    index = torch.full((1, size, size), -1, dtype=torch.int32, device=vertices.device)
    for start in range(0, len(faces), 100_000):
        chunk = drtk.rasterize(projected, faces[start:start + 100_000], height=size, width=size)
        index = torch.where(chunk >= 0, chunk + start, index)
    mask = index[0] >= 0
    _, barycentric = drtk.render(projected, faces, index)
    weights = barycentric[0].permute(1, 2, 0)[mask]
    triangles = vertices[faces[index[0][mask]].long()]
    positions = (triangles * weights[..., None]).sum(dim=1)
    if not torch.isfinite(positions).all():
        raise ValueError("UV rasterization produced non-finite surface positions")
    return mask, positions
