"""Does classifier-free guidance fix the retexture path?

The texture sampler ships with `guidance_strength: 1.0` in BOTH pipeline configs,
while sparse-structure and shape run at 7.5. At exactly 1.0 the CFG mixin
short-circuits (`classifier_free_guidance_mixin.py:10`) and returns the plain
conditional prediction — the negative branch is never evaluated. So the texture
stage is the only stage that gets no guidance toward the image at all.

Three symptoms might trace to that, and this sweep measures all three at once:

  1. metallic ~1.0 on 68% of bulma runs (the model calls a cartoon character
     metal; TRELLIS.2's own flower example measures 0.056)
  2. base colour desaturated against the source
  3. the collapse rate the retry ladder exists to paper over

One variable only: `guidance_strength`. `guidance_rescale` stays at its shipped
0.0 so a result cannot be credited to the wrong knob — raising it is the obvious
follow-up if strength alone over-saturates.

Loads the pipeline ONCE and reuses it, so the reported per-run cost is the
number that matters for a long-lived sidecar.

  uv run --project sidecar python spikes/trellis2/guidance_sweep.py
"""

from __future__ import annotations

import argparse
import glob
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
WORKSPACE = REPO / "spikes/trellis2/out/verb-e2e/bulma"


def texture_stats(mesh) -> dict:
    """Base colour and metallic, straight off the baked atlases."""
    mat = mesh.visual.material
    bc = np.asarray(mat.baseColorTexture.convert("RGB"), dtype=np.float32) / 255.0
    lit = bc.sum(-1) > 0.02
    out = {
        "baseColorMean": round(float(bc[lit].mean()), 4),
        "saturation": round(float((bc[lit].max(-1) - bc[lit].min(-1)).mean()), 4),
    }
    mr = getattr(mat, "metallicRoughnessTexture", None)
    if mr is not None:
        a = np.asarray(mr.convert("RGB"), dtype=np.float32) / 255.0
        m = a.sum(-1) > 0.02
        out["metallicMean"] = round(float(a[:, :, 2][m].mean()), 4)
        out["roughnessMean"] = round(float(a[:, :, 1][m].mean()), 4)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--strengths", type=float, nargs="+", default=[1.0, 3.0, 5.0, 7.5])
    ap.add_argument("--seeds", type=int, nargs="+", default=[0, 7, 42, 1234])
    ap.add_argument("--resolution", type=int, default=512)
    ap.add_argument("--out", default=str(REPO / "spikes/trellis2/out/guidance_sweep"))
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    mesh_path = WORKSPACE / "results/r1/model.glb"
    src = glob.glob(str(WORKSPACE / "source/*"))
    if not src:
        raise SystemExit(f"no source image under {WORKSPACE / 'source'}")
    image = t2._require_rgba(Path(src[0]))
    source_rgba = np.asarray(image, dtype=np.float32) / 255.0
    fg = source_rgba[:, :, 3] > 0.5
    src_sat = float(
        (source_rgba[:, :, :3][fg].max(-1) - source_rgba[:, :, :3][fg].min(-1)).mean()
    )
    print(f"source saturation {src_sat:.4f}  (the number every run is judged against)")

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
    load_s = time.perf_counter() - t0
    print(f"pipeline loaded once in {load_s:.1f}s\n")

    mesh = rt._load_mesh(mesh_path)
    print(f"{'strength':>9} {'seed':>6} {'metallic':>9} {'sat':>7} {'base':>7} "
          f"{'collapse':>9} {'secs':>6} {'GiB':>6}")
    rows = []
    for strength in args.strengths:
        for seed in args.seeds:
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
            t = time.perf_counter()
            out = pipeline.run(
                mesh,
                image,
                seed=seed,
                resolution=args.resolution,
                texture_size=2048,
                preprocess_image=True,
                tex_slat_sampler_params={"guidance_strength": strength},
            )
            torch.cuda.synchronize()
            secs = time.perf_counter() - t
            peak = torch.cuda.max_memory_reserved() / 1024**3

            m = rt.as_mesh(out)
            st = texture_stats(m)
            collapse = t2.kind_for_mean(rt.atlas_mean(m))
            row = {
                "guidanceStrength": strength,
                "seed": seed,
                "seconds": round(secs, 1),
                "peakReservedGiB": round(peak, 2),
                "collapse": collapse,
                **st,
            }
            rows.append(row)
            print(f"{strength:9.1f} {seed:6d} {st.get('metallicMean', float('nan')):9.3f} "
                  f"{st['saturation']:7.3f} {st['baseColorMean']:7.3f} "
                  f"{str(collapse):>9} {secs:6.1f} {peak:6.2f}")

            d = out_dir / f"g{strength:g}_s{seed}"
            d.mkdir(exist_ok=True)
            m.visual.material.baseColorTexture.save(d / "basecolor.png")
            mr = getattr(m.visual.material, "metallicRoughnessTexture", None)
            if mr is not None:
                mr.save(d / "metallicroughness.png")
            del out, m
            torch.cuda.empty_cache()

    (out_dir / "sweep.json").write_text(
        json.dumps(
            {
                "mesh": str(mesh_path),
                "image": src[0],
                "resolution": args.resolution,
                "sourceSaturation": round(src_sat, 4),
                "loadSeconds": round(load_s, 1),
                "note": "guidance_rescale left at its shipped 0.0; strength is the only variable",
                "runs": rows,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    print("\nby strength:")
    for s in args.strengths:
        g = [r for r in rows if r["guidanceStrength"] == s]
        met = np.mean([r.get("metallicMean", np.nan) for r in g])
        sat = np.mean([r["saturation"] for r in g])
        bad = sum(1 for r in g if r["collapse"] is not None)
        metal = sum(1 for r in g if r.get("metallicMean", 0) > 0.5)
        print(f"  {s:4.1f}: metallic {met:.3f} ({metal}/{len(g)} majority-metal)  "
              f"sat {sat:.3f} vs source {src_sat:.3f}  collapsed {bad}/{len(g)}  "
              f"{np.mean([r['seconds'] for r in g]):.0f}s/run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
