"""Does the metal misclassification follow the MESH or the IMAGE?

bulma retextures at 76% metal; three other subjects sit at 0-15%. Two
explanations survive that data and they imply opposite fixes:

  MESH    flat anime art generates a flat mesh, and the texturing pass encodes
          the mesh it is handed. The trigger would be geometry, the fix belongs
          upstream in generation, and the gate is treating a symptom.

  IMAGE   flat line art conditions the texture decoder badly. The trigger would
          be the art style, nothing upstream can fix it, and rejecting-and-
          rerolling is the right answer.

A 2x2 crossover separates them. Same seed in every cell, so the only things that
move are the mesh and the image:

                    bulma image        mermaid image
  bulma mesh        control (metal)    metal => MESH
  mermaid mesh      metal => IMAGE     control (clean)

The seeds are chosen to be known-bad in the control cell (1234 and 1235 both
returned 100% metal there), because a cell that starts clean cannot show which
swap rescued it. The control is re-run rather than quoted, so all four cells
come from one pipeline load under one set of settings.

  uv run --project sidecar python spikes/trellis2/crossover.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "sidecar"))

import numpy as np  # noqa: E402

from spritebook_sidecar.adapters import trellis2 as t2  # noqa: E402
from spritebook_sidecar.adapters import trellis2_retexture as rt  # noqa: E402

WEIGHTS = Path.home() / "AppData/Local/spritebook/models/trellis2-4b/af44b45f"
OUT = REPO / "spikes/trellis2/out/crossover"

# the adapter's own shipped values, so this measures what users would get
GUIDANCE = rt.DEFAULTS["textureGuidance"]
RESOLUTION = rt.DEFAULTS["resolution"]
TEXTURE_SIZE = rt.DEFAULTS["textureSize"]
SEEDS = [1234, 1235]

MESHES = {
    "bulma": REPO / "spikes/trellis2/out/verb-e2e/bulma/results/r1/model.glb",
    "mermaid": REPO / "spikes/trellis2/out/cross-subject/painted-mermaid/results/r1/model.glb",
}
IMAGES = {
    "bulma": REPO / "spikes/trellis2/refs/bulma-front.png",
    "mermaid": REPO / "spikes/trellis2/refs/painted-mermaid.png",
}


def stats(mesh) -> dict:
    mat = mesh.visual.material
    bc = np.asarray(mat.baseColorTexture.convert("RGB"), dtype=np.float32) / 255.0
    lit = bc.sum(-1) > 0.02
    out = {
        "metal": round(rt.atlas_metal_fraction(mesh), 4),
        "saturation": round(float((bc[lit].max(-1) - bc[lit].min(-1)).mean()), 4),
        "base": round(float(bc[lit].mean()), 4),
    }
    out["fault"] = t2.quality_fault(out["base"], out["metal"])
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, p in list(MESHES.items()) + list(IMAGES.items()):
        if not Path(p).is_file():
            raise SystemExit(f"missing input for '{name}': {p}")

    t2._ensure_importable()
    t2._prepare_runtime()
    import torch

    from trellis2.pipelines import Trellis2TexturingPipeline

    t0 = time.perf_counter()
    pipeline = Trellis2TexturingPipeline.from_pretrained(
        str(WEIGHTS), config_file="texturing_pipeline.json"
    )
    pipeline.low_vram = True
    pipeline.cuda()
    print(f"pipeline loaded once in {time.perf_counter() - t0:.1f}s")
    print(f"guidance {GUIDANCE}  resolution {RESOLUTION}  seeds {SEEDS}\n")

    meshes = {k: rt._load_mesh(v) for k, v in MESHES.items()}
    images = {k: t2._require_rgba(v) for k, v in IMAGES.items()}

    print(f"{'mesh':9} {'image':9} {'seed':>6} {'metal':>7} {'sat':>7} {'base':>7}  gate")
    rows = []
    for mk in MESHES:
        for ik in IMAGES:
            for seed in SEEDS:
                torch.cuda.synchronize()
                t = time.perf_counter()
                out = pipeline.run(
                    meshes[mk],
                    images[ik],
                    seed=seed,
                    resolution=RESOLUTION,
                    texture_size=TEXTURE_SIZE,
                    preprocess_image=True,
                    tex_slat_sampler_params={"guidance_strength": GUIDANCE},
                )
                torch.cuda.synchronize()
                painted = rt.as_mesh(out)
                s = stats(painted)
                s.update(mesh=mk, image=ik, seed=seed, seconds=round(time.perf_counter() - t, 1))
                rows.append(s)
                print(f"{mk:9} {ik:9} {seed:6d} {s['metal']:7.1%} {s['saturation']:7.3f} "
                      f"{s['base']:7.3f}  {'REJECT' if s['fault'] else 'pass'}")
                d = OUT / f"mesh-{mk}_img-{ik}_s{seed}"
                d.mkdir(exist_ok=True)
                painted.visual.material.baseColorTexture.save(d / "basecolor.png")
                del out, painted
                torch.cuda.empty_cache()

    (OUT / "crossover.json").write_text(
        json.dumps({"guidance": GUIDANCE, "resolution": RESOLUTION, "runs": rows}, indent=2) + "\n",
        encoding="utf-8",
    )

    print("\ncell means (metal):")
    cells = {}
    for mk in MESHES:
        for ik in IMAGES:
            g = [r for r in rows if r["mesh"] == mk and r["image"] == ik]
            cells[(mk, ik)] = float(np.mean([r["metal"] for r in g]))
            print(f"  mesh={mk:8} image={ik:8} {cells[(mk, ik)]:6.1%}")

    by_mesh = np.mean([cells[("bulma", i)] for i in IMAGES]) - np.mean(
        [cells[("mermaid", i)] for i in IMAGES]
    )
    by_image = np.mean([cells[(m, "bulma")] for m in MESHES]) - np.mean(
        [cells[(m, "mermaid")] for m in MESHES]
    )
    print(f"\nmain effect of MESH  (bulma - mermaid): {by_mesh:+.1%}")
    print(f"main effect of IMAGE (bulma - mermaid): {by_image:+.1%}")
    verdict = "MESH" if abs(by_mesh) > abs(by_image) else "IMAGE"
    print(f"\nlarger effect: {verdict}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
