"""Admission check for the optional Windows TRELLIS.2 environment."""
from spritebook_sidecar.adapters.trellis2 import _ensure_importable
from spritebook_sidecar.trellis_native_test import main

_ensure_importable()
from trellis2.pipelines import Trellis2ImageTo3DPipeline, Trellis2TexturingPipeline
from trellis2._spritebook_export import to_glb

main()
