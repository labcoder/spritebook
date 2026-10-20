"""Native admission for the external Pixal3D environment; no weight downloads."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from spritebook_sidecar.adapters.pixal3d_local import ensure_importable

ensure_importable()
import torch
import natten
from pixal3d.models.sc_vaes.fdg_vae import FlexiDualGridVaeDecoder
from pixal3d.trainers.flow_matching.mixins.image_conditioned_proj import DinoV3ProjFeatureExtractor
from pixal3d._spritebook_export import to_glb
from src.model.naf import NAF
from spritebook_sidecar.trellis_native_test import main

assert natten.HAS_LIBNATTEN, "Pixal3D requires real native NATTEN, never duplicated features"
with torch.inference_mode():
    query = torch.zeros(1, 16, 16, 4, 64, device="cuda")
    values = torch.full((1, 16, 16, 4, 256), 3.0, device="cuda")
    result = natten.na2d(query, query, values, kernel_size=(9, 9), backend="cutlass-fna")
    torch.testing.assert_close(result, values, atol=1e-5, rtol=0)
    model = NAF().cuda().eval()
    result = model(torch.rand(1, 3, 64, 64, device="cuda"), torch.ones(1, 1024, 16, 16, device="cuda"), (64, 64))
    torch.testing.assert_close(result, torch.ones_like(result), atol=1e-4, rtol=0)
    assert result.shape == (1, 1024, 64, 64)
main()
print(json.dumps({"natten": natten.__version__, "sm": torch.cuda.get_device_capability(),
                  "naf": "real CUDA forward and constant-feature preservation pass"}))
