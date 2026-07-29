"""Is the black premultiply what makes bulma read as metal?

The crossover proved the conditioning IMAGE decides it and the mesh has no say.
The remaining guess: `preprocess_image` premultiplies the cut-out onto BLACK
(`trellis2_image_to_3d.py:160`) and bulma is full of black linework, so the model
may be seeing a mostly-dark subject on a dark field.

Testing it needs care, because the premultiply is INSIDE the pipeline and always
wins: a transparent pixel times alpha=0 is black no matter what colour sits
under it. So all three conditions replicate `preprocess_image` here and go in
with `preprocess_image=False`:

  black      crop + premultiply onto black - exactly what the pipeline does.
             THE CONTROL. If this does not reproduce 100% metal, the
             replication is unfaithful and nothing below means anything.
  white      the same crop composited onto white instead.
  lifted     premultiplied onto black as usual, but with the foreground's black
             point raised so no near-black linework survives.

Seeds 1234 and 1235, both known to return 100% metal on this mesh and image.

  uv run --project sidecar python spikes/trellis2/linework_probe.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "sidecar"))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from spritebook_sidecar.adapters import trellis2 as t2  # noqa: E402
from spritebook_sidecar.adapters import trellis2_retexture as rt  # noqa: E402

WEIGHTS = Path.home() / "AppData/Local/spritebook/models/trellis2-4b/af44b45f"
MESH = REPO / "spikes/trellis2/out/verb-e2e/bulma/results/r1/model.glb"
IMAGE = REPO / "spikes/trellis2/refs/bulma-front.png"
OUT = REPO / "spikes/trellis2/out/linework"
SEEDS = [1234, 1235]
BLACK_POINT = 0.35


def cropped(path: Path) -> np.ndarray:
    """`preprocess_image` up to but NOT including the composite. (N, N, 4) in [0, 1].

    Same 1024 cap, same 0.8-alpha bbox, same square crop about its centre — so
    the only thing the conditions below differ in is what fills the background.
    """
    im = Image.open(path)
    scale = min(1, 1024 / max(im.size))
    if scale < 1:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.Resampling.LANCZOS)
    a = np.array(im)[:, :, 3]
    bb = np.argwhere(a > 0.8 * 255)
    x0, y0, x1, y1 = np.min(bb[:, 1]), np.min(bb[:, 0]), np.max(bb[:, 1]), np.max(bb[:, 0])
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    s = max(x1 - x0, y1 - y0)
    im = im.crop((cx - s // 2, cy - s // 2, cx + s // 2, cy + s // 2))
    return np.array(im).astype(np.float32) / 255.0


def condition(rgba: np.ndarray, kind: str) -> Image.Image:
    rgb, alpha = rgba[:, :, :3], rgba[:, :, 3:4]
    if kind == "black":
        out = rgb * alpha
    elif kind == "white":
        out = rgb * alpha + (1.0 - alpha)
    elif kind == "lifted":
        # raise the black point so no near-black linework survives, then
        # premultiply as usual: white stays white, pure black becomes 0.35
        out = (rgb * (1.0 - BLACK_POINT) + BLACK_POINT) * alpha
    else:
        raise ValueError(kind)
    return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    rgba = cropped(IMAGE)
    fg = rgba[:, :, 3] > 0.5
    lum = rgba[:, :, :3][fg].mean(-1)
    print(f"foreground: {fg.sum():,} px  mean luminance {lum.mean():.3f}")
    print(f"  below 0.15 (near-black linework): {(lum < 0.15).mean():.1%}")
    print(f"  below 0.30:                       {(lum < 0.30).mean():.1%}\n")

    images = {}
    for kind in ("black", "white", "lifted"):
        img = condition(rgba, kind)
        img.save(OUT / f"cond_{kind}.png")
        images[kind] = img

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
    print(f"pipeline loaded once in {time.perf_counter() - t0:.1f}s\n")
    mesh = rt._load_mesh(MESH)

    print(f"{'condition':10} {'seed':>6} {'metal':>7} {'sat':>7} {'base':>7}  gate")
    rows = []
    for kind in ("black", "white", "lifted"):
        for seed in SEEDS:
            out = pipeline.run(
                mesh,
                images[kind],
                seed=seed,
                resolution=rt.DEFAULTS["resolution"],
                texture_size=rt.DEFAULTS["textureSize"],
                preprocess_image=False,  # every condition is pre-cropped above
                tex_slat_sampler_params={
                    "guidance_strength": rt.DEFAULTS["textureGuidance"]
                },
            )
            painted = rt.as_mesh(out)
            bc = np.asarray(
                painted.visual.material.baseColorTexture.convert("RGB"), dtype=np.float32
            ) / 255.0
            lit = bc.sum(-1) > 0.02
            r = {
                "condition": kind,
                "seed": seed,
                "metal": round(rt.atlas_metal_fraction(painted), 4),
                "saturation": round(float((bc[lit].max(-1) - bc[lit].min(-1)).mean()), 4),
                "base": round(float(bc[lit].mean()), 4),
            }
            r["fault"] = t2.quality_fault(r["base"], r["metal"])
            rows.append(r)
            print(f"{kind:10} {seed:6d} {r['metal']:7.1%} {r['saturation']:7.3f} "
                  f"{r['base']:7.3f}  {'REJECT' if r['fault'] else 'pass'}")
            painted.visual.material.baseColorTexture.save(OUT / f"{kind}_s{seed}.png")
            del out, painted
            torch.cuda.empty_cache()

    (OUT / "linework.json").write_text(
        json.dumps({"blackPoint": BLACK_POINT, "runs": rows}, indent=2) + "\n", encoding="utf-8"
    )

    print()
    means = {}
    for kind in ("black", "white", "lifted"):
        g = [r for r in rows if r["condition"] == kind]
        means[kind] = float(np.mean([r["metal"] for r in g]))
        print(f"  {kind:8} metal {means[kind]:6.1%}")

    if means["black"] < 0.6:
        print("\nCONTROL FAILED: the replication does not reproduce the failure, "
              "so the other two conditions prove nothing.")
    elif means["white"] < 0.6 or means["lifted"] < 0.6:
        print("\nThe premultiply IS implicated - a condition flipped to non-metal.")
    else:
        print("\nNeither flipped. The black premultiply is NOT the mechanism; "
              "close the thread and record it as unknown.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
