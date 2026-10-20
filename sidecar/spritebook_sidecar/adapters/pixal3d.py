"""Official single-view Pixal3D in an isolated, model-managed Python runtime."""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# Load only our package, never the base environment's other site-packages.
if __package__ is None:
    import importlib.util
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("spritebook_sidecar", root / "__init__.py")
    package = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = package
    spec.loader.exec_module(package)
    __package__ = "spritebook_sidecar.adapters"

from . import Adapter, AdapterError, Emitter, validate_params

VERSION = "0.1.3"
EXPORT_TO_CANONICAL = ((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1))
PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["imagePath", "outDir", "seed", "modelDir"],
    "additionalProperties": False,
    "properties": {
        "imagePath": {"type": "string", "minLength": 1},
        "outDir": {"type": "string", "minLength": 1},
        "modelDir": {"type": "string", "minLength": 1},
        "seed": {"type": "integer", "minimum": 0},
        "steps": {"type": "integer", "minimum": 1, "maximum": 50},
        "fov": {"type": "number", "minimum": 0.05, "maximum": 1.5},
        "textureSize": {"type": "integer", "enum": [1024, 2048, 4096]},
        "decimationTarget": {"type": "integer", "minimum": 10000, "maximum": 2000000},
        "candidates": {"type": "integer", "minimum": 1, "maximum": 8},
    },
}
DEFAULTS = {"steps": 12, "fov": 0.2, "textureSize": 2048, "decimationTarget": 200000, "candidates": 1}
MARKER = "SPRITEBOOK_PIXAL_EVENT "


def camera_params(fov: float) -> dict[str, float]:
    if not math.isfinite(fov) or not 0.05 <= fov <= 1.5:
        raise AdapterError("bad-params", "Pixal3D fov must be finite and between 0.05 and 1.5 radians.")
    # Official manual-FOV distance_from_fov at mesh_scale=1, zero extended pixels.
    return {"camera_angle_x": fov, "distance": 0.5 / math.tan(fov / 2), "mesh_scale": 1.0}


def generate(p: dict[str, Any], emit: Emitter) -> None:
    from PIL import Image
    from .pixal3d_local import load_pipeline
    from .trellis2 import SEED_STRIDE, base_color_mean, metal_fraction_from_attrs, reset_vram_stats, vram_peaks
    from ..glb import validate_mesh, verify_written_glb

    camera = camera_params(float(p["fov"]))
    image = Image.open(p["imagePath"])
    if image.mode != "RGBA" or image.getextrema()[3][0] == 255 or image.getextrema()[3][1] <= 204:
        raise AdapterError("bad-input", "Pixal3D needs a cut-out RGBA image. Run `spritebook prep` first.")
    root, out_dir = Path(p["modelDir"]).resolve(), Path(p["outDir"]).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    emit.progress("load", 0, 1)
    started = time.perf_counter()
    reset_vram_stats()
    pipeline = load_pipeline(root)
    load_seconds = round(time.perf_counter() - started, 2)
    import torch
    import transformers
    import natten
    from pixal3d._spritebook_export import to_glb

    # Never construct upstream BRIA: alpha/crop/compositing is the only prep needed here.
    image = pipeline.preprocess_image(image)
    entries, paths = [], []
    for index in range(int(p["candidates"])):
        seed = int(p["seed"]) + index * SEED_STRIDE
        emit.progress(f"generate:seed{seed}", index, int(p["candidates"]))
        started = time.perf_counter()
        mesh = pipeline.run(image, camera_params=camera, seed=seed, preprocess_image=False,
                            pipeline_type="1024_cascade",
                            sparse_structure_sampler_params={"steps": int(p["steps"])},
                            shape_slat_sampler_params={"steps": int(p["steps"])},
                            tex_slat_sampler_params={"steps": int(p["steps"])})[0]
        if (not len(mesh.faces) or not len(mesh.attrs) or
                not all(torch.isfinite(x).all() for x in (mesh.vertices, mesh.attrs))):
            raise AdapterError("backend-failed", "Pixal3D produced empty or non-finite geometry/materials.", True)
        color_mean, metal = base_color_mean(mesh.attrs), metal_fraction_from_attrs(mesh.attrs)
        # Reject numerical material collapse, without assuming TRELLIS's character-specific metal budget.
        if float(mesh.attrs[:, :3].std(dim=0).amax()) < 0.001:
            raise AdapterError("texture-rejected", "Pixal3D produced a constant base-color material. Retry with another seed.", True)
        seconds = round(time.perf_counter() - started, 2)
        emit.progress("encode", index, int(p["candidates"]))
        glb = to_glb(vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs,
                     coords=mesh.coords, attr_layout=mesh.layout, voxel_size=mesh.voxel_size,
                     aabb=[[-0.5] * 3, [0.5] * 3], decimation_target=int(p["decimationTarget"]),
                     texture_size=int(p["textureSize"]), remesh=True, remesh_band=1, remesh_project=0)
        # Pixal's projection is already Y-up/+Z-front; undo the TRELLIS exporter's Z-up conversion.
        glb.apply_transform(EXPORT_TO_CANONICAL)
        validate_mesh(glb.vertices, glb.vertex_normals, glb.visual.uv, glb.faces.reshape(-1))
        path = out_dir / ("raw.glb" if index == 0 else f"raw-{index}.glb")
        glb.export(str(path))
        verify_written_glb(path, expect_vertices=len(glb.vertices), expect_indices=glb.faces.size)
        entries.append({"index": index, "requestedSeed": seed, "effectiveSeed": seed,
                        "seedsTried": [seed], "runSeconds": seconds,
                        "baseColorMean": color_mean, "metalFraction": metal})
        paths.append(path)
        del mesh, glb
    meta = {"adapter": "pixal3d", "adapterVersion": VERSION, "requestedSeed": entries[0]["requestedSeed"],
            "effectiveSeed": entries[0]["effectiveSeed"], "seedsTried": entries[0]["seedsTried"],
            "candidates": entries, "pipelineType": "1024_cascade", "lowVram": True,
            "cameraMode": "manual-fov", "camera": camera, "coordinateFrame": "y-up-z-forward",
            "naf": "strict", "loadSeconds": load_seconds,
            "runtimeVersions": {"python": sys.version.split()[0], "torch": torch.__version__,
                                "transformers": transformers.__version__, "natten": natten.__version__},
            "runSeconds": round(sum(e["runSeconds"] for e in entries), 2), **vram_peaks()}
    path = out_dir / "gen-meta.json"
    path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    emit.artifact("gen-meta", str(path))
    for path in paths:
        emit.artifact("mesh-raw", str(path))


def run(params: dict[str, Any], emit: Emitter) -> None:
    p = validate_params(PARAMS_SCHEMA, params, DEFAULTS)
    python = Path(os.environ.get("SPRITEBOOK_PIXAL3D_PYTHON", ""))
    if not python.is_absolute() or not python.is_file():
        raise AdapterError("backend-unavailable", "Pixal3D runtime is missing. Run `spritebook models setup pixal3d --accept-license`.")
    env = {**os.environ, "PYTHONUTF8": "1"}
    error = None
    with subprocess.Popen([str(python), str(Path(__file__).resolve()), json.dumps(p)], env=env,
                          stdout=subprocess.PIPE, stderr=sys.stderr, text=True, encoding="utf-8") as child:
        for line in child.stdout:
            if not line.startswith(MARKER):
                sys.stderr.write(line)
                continue
            event = json.loads(line[len(MARKER):])
            kind = event["t"]
            if kind == "progress":
                emit.progress(event["step"], event["done"], event["total"])
            elif kind == "artifact":
                emit.artifact(event["kind"], event["path"])
            elif kind == "warn":
                emit.warn(event["code"], event["message"])
            elif kind == "error":
                error = AdapterError(event["code"], event["message"], event["retryable"])
        code = child.wait()
    if error is not None:
        raise error
    if code != 0:
        raise AdapterError("backend-failed", f"Pixal3D worker exited {code}. Retry after checking available memory and model setup.", True)


ADAPTER = Adapter(id="pixal3d", kind="gen3d", version=VERSION, params_schema=PARAMS_SCHEMA,
                  defaults=DEFAULTS, run=run,
                  description="Pixal3D single-view PBR generation, real NAF, low-VRAM 1024 cascade and explicit manual camera FOV.")


if __name__ == "__main__":
    from ..events import JobEmitter, ev_error
    stream = sys.stdout
    sys.stdout = sys.stderr

    def write(event: dict[str, Any]) -> None:
        stream.write(MARKER + json.dumps(event) + "\n")
        stream.flush()

    try:
        generate(validate_params(PARAMS_SCHEMA, json.loads(sys.argv[1]), DEFAULTS), JobEmitter("pixal-worker", write))
    except Exception as exc:
        import traceback
        traceback.print_exc()
        error = exc if isinstance(exc, AdapterError) else AdapterError("backend-failed", f"Pixal3D failed: {exc}", True)
        write(ev_error("pixal-worker", error.code, error.message, error.retryable))
        sys.exit(1)
