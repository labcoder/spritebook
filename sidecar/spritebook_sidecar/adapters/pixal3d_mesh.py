"""Deterministic reduction/normals around Pixal's native remesh and UV stages."""
from __future__ import annotations


def simplify_mesh(mesh, target: int) -> None:
    import numpy as np
    import torch
    import trimesh

    vertices, faces = mesh.read()
    points, triangles = vertices.cpu().numpy(), faces.cpu().numpy()
    if (not len(points) or not len(triangles) or not np.isfinite(points).all() or
            triangles.min() < 0 or triangles.max() >= len(points)):
        raise ValueError("Pixal mesh reduction received invalid geometry")
    # Native remeshing may enumerate the same surface differently between jobs.
    points, inverse = np.unique(points, axis=0, return_inverse=True)
    triangles = inverse[triangles]
    minimum = triangles.argmin(axis=1)
    triangles = np.take_along_axis(triangles, (np.arange(3)[None, :] + minimum[:, None]) % 3, axis=1)
    triangles = np.unique(triangles, axis=0)
    reduced = trimesh.Trimesh(vertices=points, faces=triangles, process=False)
    if len(triangles) > target:
        reduced = reduced.simplify_quadric_decimation(face_count=target)
    mesh.init(torch.from_numpy(np.ascontiguousarray(reduced.vertices, dtype=np.float32)).to(vertices.device),
              torch.from_numpy(np.ascontiguousarray(reduced.faces, dtype=np.int32)).to(vertices.device))


def vertex_normals(mesh):
    import numpy as np
    import torch
    import trimesh

    vertices, faces = mesh.read()
    surface = trimesh.Trimesh(vertices=vertices.cpu().numpy(), faces=faces.cpu().numpy(), process=False)
    return torch.from_numpy(np.ascontiguousarray(surface.vertex_normals, dtype=np.float32)).to(vertices.device)
