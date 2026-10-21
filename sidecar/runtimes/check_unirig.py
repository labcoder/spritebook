"""Native admission checks; real bpy stages are also validated by their artifacts."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# bpy can crash at teardown; a valid mesh artifact proves the isolated stage completed.
with tempfile.TemporaryDirectory(prefix="spritebook-unirig-bpy-") as temp:
    artifact = Path(temp) / "mesh.json"
    probe = subprocess.run([
        sys.executable, "-I", "-c",
        "import bpy,json,sys; m=bpy.data.meshes.new('probe'); "
        "m.from_pydata([(0,0,0),(1,0,0),(0,1,0)],[],[(0,1,2)]); "
        "open(sys.argv[1],'w').write(json.dumps([len(m.vertices),len(m.polygons)]))",
        str(artifact),
    ], capture_output=True, text=True, timeout=120)
    if not artifact.is_file() or json.loads(artifact.read_text()) != [3, 1]:
        raise RuntimeError(f"UniRig Blender check failed ({probe.returncode}): {probe.stderr[-2000:]}")

import numpy as np
import torch
import torch_cluster
import torch_scatter
import spconv.pytorch as spconv
import pyrender
import trimesh

sys.path.insert(0, os.environ["SPRITEBOOK_UNIRIG_HOME"])
from src.model.unirig_skin import MHA

assert torch.cuda.is_available(), "UniRig requires NVIDIA CUDA"
values = torch.tensor([1.0, 2.0, 3.0], device="cuda")
groups = torch.tensor([0, 1, 0], device="cuda")
torch.testing.assert_close(torch_scatter.scatter_add(values, groups), torch.tensor([4.0, 2.0], device="cuda"))
points = torch.tensor([[0., 0., 0.], [1., 0., 0.], [3., 0., 0.]], device="cuda")
assert torch_cluster.knn_graph(points, k=1).shape == (2, 3)
indices = torch.tensor([[0, 1, 1, 1], [0, 1, 1, 2], [0, 1, 2, 1]], dtype=torch.int32, device="cuda")
sparse = spconv.SparseConvTensor(torch.ones(3, 2, device="cuda"), indices, [4, 4, 4], 1)
result = spconv.SubMConv3d(2, 2, 3, padding=1, bias=False).cuda()(sparse)
assert result.features.shape == (3, 2) and torch.isfinite(result.features).all()
attention = MHA(embed_dim=16, num_heads=4, cross_attn=True, use_flash_attn=False).cuda().eval()
with torch.no_grad():
    output = attention(torch.ones(1, 2, 16, device="cuda"), x_kv=torch.ones(1, 3, 16, device="cuda"))
assert output.shape == (1, 2, 16) and torch.isfinite(output).all()

scene = pyrender.Scene()
scene.add(pyrender.Mesh.from_trimesh(trimesh.creation.box()))
pose = np.eye(4)
pose[2, 3] = 3
scene.add(pyrender.PerspectiveCamera(yfov=np.pi / 3), pose=pose)
renderer = pyrender.OffscreenRenderer(16, 16)
try:
    _, depth = renderer.render(scene)
    assert np.isfinite(depth).all() and (depth > 0).any(), "pyrender produced no finite covered pixels"
finally:
    renderer.delete()
print(json.dumps({"torch": torch.__version__, "gpu": torch.cuda.get_device_name(),
                  "checks": "bpy mesh artifact/PyG/spconv/standard attention/pyrender pass"}))
