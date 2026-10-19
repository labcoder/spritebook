"""Load the registry's local TRELLIS.2 files without upstream Hub fallbacks."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import AdapterError

DINO_ID = "facebook/dinov3-vitl16-pretrain-lvd1689m"
DECODER_ID = "microsoft/TRELLIS-image-large/ckpts/ss_dec_conv3d_16l8_fp16"


def local_file(root: Path, name: str) -> Path:
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise AdapterError(
            "model-missing",
            f"Declared TRELLIS.2 dependency is missing or outside its model directory: {name}. "
            "Install the complete model with `spritebook models install trellis2-4b`.",
        )
    return path


def load_local_pipeline(cls: Any, path: str, config_file: str = "pipeline.json") -> Any:
    from trellis2 import models

    root = Path(path).resolve()
    if config_file not in ("pipeline.json", "texturing_pipeline.json"):
        raise AdapterError("bad-input", f"Unknown TRELLIS.2 pipeline config: {config_file}")
    args = json.loads(local_file(root, config_file).read_text(encoding="utf-8"))["args"]
    conditioner = args["image_cond_model"]
    if conditioner["name"] != "DinoV3FeatureExtractor" or conditioner["args"]["model_name"] != DINO_ID:
        raise AdapterError("backend-unavailable", "The pipeline declares an unknown image conditioner.")
    for name in ("config.json", "model.safetensors", "LICENSE.md"):
        local_file(root, f"deps/dinov3/{name}")
    conditioner["args"]["model_name"] = str(root / "deps/dinov3")
    loaded = {}
    for key, reference in args["models"].items():
        if hasattr(cls, "model_names_to_load") and key not in cls.model_names_to_load:
            continue
        if reference == DECODER_ID:
            reference = "deps/trellis-image-large/ckpts/ss_dec_conv3d_16l8_fp16"
        prefix = local_file(root, reference + ".json").with_suffix("")
        local_file(root, reference + ".safetensors")
        loaded[key] = models.from_pretrained(str(prefix))
    pipeline = cls(loaded)
    pipeline._pretrained_args = args
    return pipeline


def install_local_loaders() -> None:
    from transformers import DINOv3ViTModel
    from trellis2.modules import image_feature_extractor
    from trellis2.pipelines.base import Pipeline

    class LocalDinoModel:
        @staticmethod
        def from_pretrained(path: str) -> Any:
            root = Path(path).resolve()
            local_file(root, "config.json")
            local_file(root, "model.safetensors")
            return DINOv3ViTModel.from_pretrained(str(root), local_files_only=True)

    # Patch the integration module's constructor, never the shared Transformers class.
    image_feature_extractor.DINOv3ViTModel = LocalDinoModel
    Pipeline.from_pretrained = classmethod(load_local_pipeline)
