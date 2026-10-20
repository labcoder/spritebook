"""Local-only official Pixal3D models and real NAF; no Hub or mirror fallback."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from . import AdapterError


def ensure_importable() -> None:
    os.environ["ATTN_BACKEND"] = "sdpa"
    os.environ["SPARSE_ATTN_BACKEND"] = "sdpa"
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    for key, package in (("SPRITEBOOK_PIXAL3D_CODE", "pixal3d"), ("SPRITEBOOK_NAF_CODE", "src")):
        root = Path(os.environ.get(key, ""))
        if not root.is_absolute() or not (root / package).is_dir():
            raise AdapterError("backend-unavailable", "Pixal3D sources are missing. Run `spritebook models setup pixal3d --accept-license`.")
        sys.path.insert(0, str(root))
    from .trellis2_windows import install
    install()


def local_file(root: Path, name: str) -> Path:
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise AdapterError("model-missing", f"Pixal3D dependency is missing or outside its model directory: {name}. Run `spritebook models install pixal3d --accept-license`.")
    return path


def load_pipeline(root: Path) -> Any:
    ensure_importable()
    import torch
    from safetensors.torch import load_file
    from transformers import DINOv3ViTModel
    from pixal3d import models
    from pixal3d.pipelines import Pixal3DImageTo3DPipeline, samplers
    from pixal3d.trainers.flow_matching.mixins import image_conditioned_proj as projection
    from src.model.naf import NAF

    args = json.loads(local_file(root, "pipeline.json").read_text(encoding="utf-8"))["args"]
    for name in ("config.json", "model.safetensors", "LICENSE.md"):
        local_file(root, f"deps/dinov3/{name}")
    naf_path = local_file(root, "deps/naf/naf_release.pth")

    class LocalDino:
        @staticmethod
        def from_pretrained(path: str) -> Any:
            if Path(path).resolve() != (root / "deps/dinov3").resolve():
                raise AdapterError("model-missing", "Pixal3D requires its declared local DINOv3 conditioner.")
            return DINOv3ViTModel.from_pretrained(path, local_files_only=True)

    class LocalFeatures(projection.DinoV3ProjFeatureExtractor):
        def _load_naf(self) -> None:
            if self.naf_model is None:
                self.naf_model = NAF()
                self.naf_model.load_state_dict(torch.load(naf_path, map_location="cpu", weights_only=True), strict=True)
                self.naf_model.eval().requires_grad_(False).to(next(self.model.parameters()).device)

    projection.DINOv3ViTModel = LocalDino
    loaded = {}
    for name, reference in args["models"].items():
        config = json.loads(local_file(root, reference + ".json").read_text(encoding="utf-8"))
        state = load_file(str(local_file(root, reference + ".safetensors")))
        model = getattr(models, config["name"])(**config["args"])
        model.load_state_dict(state, strict=True)
        loaded[name] = model
        del state
    pipeline = Pixal3DImageTo3DPipeline(loaded, low_vram=True)
    for stage in ("sparse_structure", "shape_slat", "tex_slat"):
        spec = args[stage + "_sampler"]
        setattr(pipeline, stage + "_sampler", getattr(samplers, spec["name"])(**spec["args"]))
        setattr(pipeline, stage + "_sampler_params", spec["params"])
    for stage in ("shape_slat", "tex_slat"):
        setattr(pipeline, stage + "_normalization", args[stage + "_normalization"])
    for name, image_size, grid, target in (("ss", 512, 16, None), ("shape_512", 512, 32, 512),
                                          ("shape_1024", 1024, 64, 512), ("tex_1024", 1024, 64, 1024)):
        conditioner = LocalFeatures(str(root / "deps/dinov3"), image_size=image_size,
                                    grid_resolution=grid, use_naf_upsample=target is not None,
                                    naf_target_size=target)
        conditioner.eval().requires_grad_(False)
        if target is not None:
            conditioner._load_naf()
        setattr(pipeline, "image_cond_model_" + name, conditioner)
    pipeline.cuda()
    return pipeline
