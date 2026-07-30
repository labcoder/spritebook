"""A1: tier x texture-guidance x rescale, gen and retexture legs.

The rubric is A1-SWEEP.md, committed BEFORE this ran. This script only
collects; the decision rule lives there. Resumable: every sample appends one
JSONL row keyed by (leg, tier, strength, rescale, subject, seed), and a re-run
skips keys already present, so an OOM or a reboot costs one sample.

  uv run --project sidecar python spikes/trellis2/a1_sweep.py            # full grid
  uv run --project sidecar python spikes/trellis2/a1_sweep.py --smoke    # 1 sample per leg
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "sidecar"))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from spritebook_sidecar.adapters import trellis2 as t2  # noqa: E402
from spritebook_sidecar.adapters import trellis2_retexture as rt  # noqa: E402

WEIGHTS = Path.home() / "AppData/Local/spritebook/models/trellis2-4b/af44b45f"
OUT = REPO / "spikes/trellis2/out/a1-sweep"
REFS = REPO / "spikes/trellis2/refs"

SUBJECTS = {"bulma": REFS / "bulma-front.png", "mermaid": REFS / "painted-mermaid.png"}
SEEDS = [7, 100, 201, 500]
CELLS = [(1.0, 0.0), (2.0, 0.0), (2.0, 0.2), (3.5, 0.0), (3.5, 0.2), (7.5, 0.0), (7.5, 0.2)]
TIERS = ["512", "1024_cascade"]
RETEX_MESH = REPO / "spikes/trellis2/out/p3-exit/bulma-fixed/canonical/model.glb"


# --- Oklab (Ottosson), numpy, matching packages/style/oklab.ts ---------------
def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """rgb in [0,1], shape (..., 3) -> Oklab (..., 3)."""
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    l = 0.4122214708 * lin[..., 0] + 0.5363325363 * lin[..., 1] + 0.0514459929 * lin[..., 2]
    m = 0.2119034982 * lin[..., 0] + 0.6806995451 * lin[..., 1] + 0.1073969566 * lin[..., 2]
    s = 0.0883024619 * lin[..., 0] + 0.2817188376 * lin[..., 1] + 0.6299787005 * lin[..., 2]
    l_, m_, s_ = np.cbrt(l), np.cbrt(m), np.cbrt(s)
    return np.stack(
        [
            0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
            1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
            0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
        ],
        axis=-1,
    )


def oklab_stats(rgb: np.ndarray) -> dict:
    """Mean L/a/b/C + HSV saturation over pixels rgb (N,3) in [0,1]."""
    lab = srgb_to_oklab(rgb)
    mean = lab.mean(axis=0)
    chroma = float(np.hypot(lab[:, 1], lab[:, 2]).mean())
    sat = float((rgb.max(-1) - rgb.min(-1)).mean())
    return {
        "L": round(float(mean[0]), 4),
        "a": round(float(mean[1]), 4),
        "b": round(float(mean[2]), 4),
        "C": round(chroma, 4),
        "sat": round(sat, 4),
    }


def source_stats(path: Path) -> dict:
    img = np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32) / 255.0
    fg = img[:, :, 3] > 0.5
    return oklab_stats(img[:, :, :3][fg])


def texture_stats(mesh) -> dict:
    """Stats off the EXPORTED mesh's baked baseColor atlas, like production ships."""
    mat = mesh.visual.material
    bc = np.asarray(mat.baseColorTexture.convert("RGB"), dtype=np.float32) / 255.0
    lit = bc.sum(-1) > 0.02
    out = {"tex": oklab_stats(bc[lit])}
    mr = getattr(mat, "metallicRoughnessTexture", None)
    if mr is not None:
        a = np.asarray(mr.convert("RGB"), dtype=np.float32) / 255.0
        m = a.sum(-1) > 0.02
        out["metal"] = round(float((a[:, :, 2][m] > 0.5).mean()), 4) if m.any() else 0.0
    else:
        out["metal"] = 0.0
    return out


def deltas(tex: dict, src: dict) -> dict:
    return {
        "hueDist": round(float(np.hypot(tex["a"] - src["a"], tex["b"] - src["b"])), 4),
        "chromaDelta": round(tex["C"] - src["C"], 4),
        "satDelta": round(tex["sat"] - src["sat"], 4),
        "lDelta": round(tex["L"] - src["L"], 4),
    }


def key_of(row: dict) -> str:
    return "|".join(
        str(row[k]) for k in ("leg", "tier", "strength", "rescale", "subject", "seed")
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="one sample per leg, to prove the harness")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    jsonl = OUT / "sweep.jsonl"
    done: set[str] = set()
    if jsonl.exists():
        for line in jsonl.read_text(encoding="utf-8").splitlines():
            if line.strip():
                done.add(key_of(json.loads(line)))
    print(f"resuming past {len(done)} samples" if done else "fresh run")

    src = {name: source_stats(p) for name, p in SUBJECTS.items()}
    for name, s in src.items():
        print(f"source {name}: {s}")

    t2._ensure_importable()
    t2._prepare_runtime()
    import torch

    def record(row: dict) -> None:
        with jsonl.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        done.add(key_of(row))

    cells = CELLS[1:2] if args.smoke else CELLS
    seeds = SEEDS[:1] if args.smoke else SEEDS
    tiers = TIERS[:1] if args.smoke else TIERS
    subjects = dict(list(SUBJECTS.items())[:1]) if args.smoke else SUBJECTS

    # ---- gen leg: ONE pipeline load serves both tiers -----------------------
    gen_todo = [
        {"leg": "gen", "tier": t, "strength": g, "rescale": r, "subject": n, "seed": s}
        for t in tiers
        for (g, r) in cells
        for n in subjects
        for s in seeds
        if "|".join([f"gen|{t}|{g}|{r}|{n}|{s}"]) not in done
    ]
    gen_todo = [r for r in gen_todo if key_of(r) not in done]
    if gen_todo:
        print(f"gen leg: {len(gen_todo)} samples to run")
        t0 = time.perf_counter()
        pipeline = t2._load_pipeline(WEIGHTS, low_vram=True)
        print(f"gen pipeline loaded in {time.perf_counter() - t0:.1f}s")
        images = {n: t2._require_rgba(p) for n, p in subjects.items()}
        for i, r in enumerate(gen_todo):
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
            t = time.perf_counter()
            fault = None
            try:
                mesh = pipeline.run(
                    images[r["subject"]],
                    seed=r["seed"],
                    pipeline_type=r["tier"],
                    preprocess_image=True,
                    sparse_structure_sampler_params={"steps": 12, "guidance_strength": 7.5},
                    shape_slat_sampler_params={"steps": 12, "guidance_strength": 7.5},
                    tex_slat_sampler_params={
                        "guidance_strength": r["strength"],
                        "guidance_rescale": r["rescale"],
                    },
                )[0]
                fault = t2.quality_fault(
                    t2.base_color_mean(mesh.attrs), t2.metal_fraction_from_attrs(mesh.attrs)
                )
            except Exception as err:  # noqa: BLE001 - a crashed sample is a row, not a crash
                row = {**r, "error": f"{type(err).__name__}: {err}", "wallSeconds": round(time.perf_counter() - t, 1)}
                record(row)
                print(f"[{i + 1}/{len(gen_todo)}] {key_of(r)} ERROR {row['error']}")
                torch.cuda.empty_cache()
                continue
            d = OUT / f"gen_{r['tier']}_g{r['strength']:g}_r{r['rescale']:g}_{r['subject']}_s{r['seed']}"
            d.mkdir(exist_ok=True)
            t2._export_glb(mesh, d / "mesh.glb", texture_size=2048, decimation=200000)
            exported = rt.as_mesh(rt._load_mesh(d / "mesh.glb"))
            exported.visual.material.baseColorTexture.save(d / "basecolor.png")
            st = texture_stats(exported)
            torch.cuda.synchronize()
            row = {
                **r,
                **st["tex"],
                **deltas(st["tex"], src[r["subject"]]),
                "metal": st["metal"],
                "collapse": fault,
                "wallSeconds": round(time.perf_counter() - t, 1),
                "peakGiB": round(torch.cuda.max_memory_reserved() / 1024**3, 2),
            }
            record(row)
            print(
                f"[{i + 1}/{len(gen_todo)}] {key_of(r)} hueDist {row['hueDist']} "
                f"dC {row['chromaDelta']} metal {row['metal']} "
                f"{'COLLAPSE ' + fault if fault else ''} {row['wallSeconds']}s {row['peakGiB']}GiB"
            )
            del mesh, exported
            torch.cuda.empty_cache()
        del pipeline
        torch.cuda.empty_cache()

    # ---- retexture leg: fixed geometry, texturing pipeline ------------------
    rt_todo = [
        {"leg": "retexture", "tier": "512", "strength": g, "rescale": r, "subject": "bulma", "seed": s}
        for (g, r) in cells
        for s in seeds
    ]
    rt_todo = [r for r in rt_todo if key_of(r) not in done]
    if rt_todo:
        print(f"retexture leg: {len(rt_todo)} samples to run")
        from trellis2.pipelines import Trellis2TexturingPipeline

        t0 = time.perf_counter()
        pipe = Trellis2TexturingPipeline.from_pretrained(
            str(WEIGHTS), config_file="texturing_pipeline.json"
        )
        pipe.low_vram = True
        pipe.cuda()
        print(f"texturing pipeline loaded in {time.perf_counter() - t0:.1f}s")
        mesh_in = rt._load_mesh(RETEX_MESH)
        image = t2._require_rgba(SUBJECTS["bulma"])
        for i, r in enumerate(rt_todo):
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
            t = time.perf_counter()
            try:
                out = pipe.run(
                    mesh_in,
                    image,
                    seed=r["seed"],
                    resolution=512,
                    texture_size=2048,
                    preprocess_image=True,
                    tex_slat_sampler_params={
                        "guidance_strength": r["strength"],
                        "guidance_rescale": r["rescale"],
                    },
                )
            except Exception as err:  # noqa: BLE001
                row = {**r, "error": f"{type(err).__name__}: {err}", "wallSeconds": round(time.perf_counter() - t, 1)}
                record(row)
                print(f"[{i + 1}/{len(rt_todo)}] {key_of(r)} ERROR {row['error']}")
                torch.cuda.empty_cache()
                continue
            painted = rt.as_mesh(out)
            fault = t2.quality_fault(rt.atlas_mean(painted), rt.atlas_metal_fraction(painted))
            d = OUT / f"rt_g{r['strength']:g}_r{r['rescale']:g}_s{r['seed']}"
            d.mkdir(exist_ok=True)
            painted.visual.material.baseColorTexture.save(d / "basecolor.png")
            st = texture_stats(painted)
            torch.cuda.synchronize()
            row = {
                **r,
                **st["tex"],
                **deltas(st["tex"], src["bulma"]),
                "metal": st["metal"],
                "collapse": fault,
                "wallSeconds": round(time.perf_counter() - t, 1),
                "peakGiB": round(torch.cuda.max_memory_reserved() / 1024**3, 2),
            }
            record(row)
            print(
                f"[{i + 1}/{len(rt_todo)}] {key_of(r)} hueDist {row['hueDist']} "
                f"dC {row['chromaDelta']} metal {row['metal']} "
                f"{'COLLAPSE ' + fault if fault else ''} {row['wallSeconds']}s"
            )
            del out, painted
            torch.cuda.empty_cache()

    print("A1 SWEEP COMPLETE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
