"""Opt-in native assertions: python -m spritebook_sidecar.trellis_native_test."""
from __future__ import annotations

import importlib.util
import json
import os

import torch
import o_voxel_vb_ap as o_voxel

from .adapters.trellis2_uv import rasterize_uv
from .adapters.trellis2_windows import install as install_windows_compat


def main() -> None:
    install_windows_compat()
    assert torch.cuda.is_available(), "This explicitly requested check requires CUDA"
    from triton import knobs
    from flex_gemm.ops.grid_sample import grid_sample_3d

    if cache := os.environ.get("TRITON_CACHE_DIR"):
        assert knobs.cache.dir == cache, "Triton must read the Unicode environment without loss"
    xyz = torch.cartesian_prod(torch.arange(2), torch.arange(2), torch.arange(2)).cuda().int()
    coords = torch.cat((torch.zeros((8, 1), device="cuda", dtype=torch.int32), xyz), dim=1)
    constant = torch.tensor([0.1, 0.2, 0.3, 0.4, 0.5, 0.6], device="cuda")
    sampled = grid_sample_3d(
        constant[None].expand(8, -1).contiguous(), coords, torch.Size([1, 6, 2, 2, 2]),
        torch.full((1, 1, 3), 0.75, device="cuda"), mode="trilinear",
    )
    torch.testing.assert_close(sampled.reshape(1, 6), constant.reshape(1, 6), atol=1e-6, rtol=0)
    for name in ("nvdiffrast", "nvdiffrec_render", "o_voxel"):
        assert importlib.util.find_spec(name) is None, f"Old dependency still installed: {name}"
    vertices = torch.tensor([[0, 0, 2], [1, 0, 2], [1, 1, 2], [0, 1, 2]], device="cuda", dtype=torch.float32)
    uvs = vertices[:, :2].contiguous()
    faces = torch.tensor([[0, 1, 2], [0, 2, 3]], device="cuda", dtype=torch.int32)
    for size in (4, 100):
        y, x = torch.meshgrid(torch.arange(size, device="cuda"), torch.arange(size, device="cuda"), indexing="ij")
        expected = torch.stack(((x + 0.5) / size, (y + 0.5) / size, torch.full_like(x, 2)), dim=-1).reshape(-1, 3)
        for topology in (faces, faces.flip(1)):
            mask, positions = rasterize_uv(vertices, topology, uvs, size)
            assert mask.all(), "UV boundaries/seam must cover the entire square"
            torch.testing.assert_close(positions, expected, atol=2e-6, rtol=0)
    # The second half is in another chunk; local face IDs would interpolate the wrong triangle.
    many = torch.cat((faces[:1].expand(100_000, -1), faces[1:]), dim=0)
    mask, positions = rasterize_uv(vertices, many, uvs, 4)
    y, x = torch.meshgrid(torch.arange(4, device="cuda"), torch.arange(4, device="cuda"), indexing="ij")
    expected = torch.stack(((x + 0.5) / 4, (y + 0.5) / 4, torch.full_like(x, 2)), dim=-1).reshape(-1, 3)
    assert mask.all()
    torch.testing.assert_close(positions, expected, atol=2e-6, rtol=0)
    mask, positions = rasterize_uv(vertices, faces[:1], torch.zeros_like(uvs), 4)
    assert not mask.any() and positions.shape == (0, 3), "Degenerate UVs must remain background"

    cube = torch.tensor([
        [-0.2, -0.2, -0.2], [0.2, -0.2, -0.2], [0.2, 0.2, -0.2], [-0.2, 0.2, -0.2],
        [-0.2, -0.2, 0.2], [0.2, -0.2, 0.2], [0.2, 0.2, 0.2], [-0.2, 0.2, 0.2],
    ])
    triangles = torch.tensor([[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                              [2, 3, 7], [2, 7, 6], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]])
    coords, dual, flags = o_voxel.convert.mesh_to_flexible_dual_grid(
        cube, triangles, grid_size=16, aabb=[[-0.5] * 3, [0.5] * 3],
    )
    assert len(coords) > 0 and torch.isfinite(dual).all()
    mesh, indices = o_voxel.convert.flexible_dual_grid_to_mesh(
        coords.cuda(), dual.cuda(), flags.cuda(), split_weight=None,
        grid_size=16, aabb=[[-0.5] * 3, [0.5] * 3],
    )
    assert len(mesh) > 0 and len(indices) > 0 and torch.isfinite(mesh).all()
    assert indices.min() >= 0 and indices.max() < len(mesh)
    torch.cuda.synchronize()
    print(json.dumps({"gpu": torch.cuda.get_device_name(), "torch": torch.__version__, "cuda": torch.version.cuda,
                      "uv": "coverage/winding/orientation/chunk offsets/degenerates pass", "dualGridFaces": len(indices),
                      "sparseSampling": "six PBR channels and native compilation pass"}))


if __name__ == "__main__":
    main()
