"""C-wave grids: C1 steps, C3 textureSize, C4 preprocessing pin.

Rubrics are C-WAVE.md, committed BEFORE this ran. One pipeline load serves
every gen sample. Resumable per sample like a1_sweep.py.

  uv run --project sidecar python spikes/trellis2/c_wave.py
"""

from __future__ import annotations

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
OUT = REPO / "spikes/trellis2/out/c-wave"
REFS = REPO / "spikes/trellis2/refs"
SUBJECTS = {"bulma": REFS / "bulma-front.png", "mermaid": REFS / "painted-mermaid.png"}

# frozen A1 defaults
TIER = "512"
GUIDANCE = 3.5
RESCALE = 0.2


def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
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


def stats_of(rgb: np.ndarray) -> dict:
    lab = srgb_to_oklab(rgb)
    mean = lab.mean(axis=0)
    return {
        "L": round(float(mean[0]), 4),
        "a": round(float(mean[1]), 4),
        "b": round(float(mean[2]), 4),
        "C": round(float(np.hypot(lab[:, 1], lab[:, 2]).mean()), 4),
    }


def source_stats(path: Path) -> dict:
    img = np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32) / 255.0
    fg = img[:, :, 3] > 0.5
    return stats_of(img[:, :, :3][fg])


def texture_stats(mesh) -> dict:
    mat = mesh.visual.material
    bc = np.asarray(mat.baseColorTexture.convert("RGB"), dtype=np.float32) / 255.0
    lit = bc.sum(-1) > 0.02
    out = {"tex": stats_of(bc[lit]), "texRes": int(bc.shape[0])}
    mr = getattr(mat, "metallicRoughnessTexture", None)
    if mr is not None:
        a = np.asarray(mr.convert("RGB"), dtype=np.float32) / 255.0
        m = a.sum(-1) > 0.02
        out["metal"] = round(float((a[:, :, 2][m] > 0.5).mean()), 4) if m.any() else 0.0
    else:
        out["metal"] = 0.0
    return out


def key_of(row: dict) -> str:
    return "|".join(str(row[k]) for k in ("leg", "steps", "textureSize", "subject", "seed"))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    jsonl = OUT / "sweep.jsonl"
    done: set[str] = set()
    if jsonl.exists():
        for line in jsonl.read_text(encoding="utf-8").splitlines():
            if line.strip():
                done.add(key_of(json.loads(line)))
    print(f"resuming past {len(done)} samples" if done else "fresh run")

    src = {name: source_stats(p) for name, p in SUBJECTS.items()}

    # C4's flattened variant: same bulma image on white, alpha dropped
    flat_path = OUT / "bulma-flattened.png"
    if not flat_path.exists():
        img = Image.open(SUBJECTS["bulma"]).convert("RGBA")
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        bg.alpha_composite(img)
        bg.convert("RGB").save(flat_path)

    t2._ensure_importable()
    t2._prepare_runtime()
    import torch

    def record(row: dict) -> None:
        with jsonl.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        done.add(key_of(row))

    todo: list[dict] = []
    # C1: steps grid at production textureSize
    for steps in (12, 20, 35):
        for name in SUBJECTS:
            for seed in (7, 100):
                todo.append(
                    {"leg": "c1", "steps": steps, "textureSize": 2048, "subject": name, "seed": seed}
                )
    # C3: textureSize 4096 cells (2048 is covered by c1 steps=12 rows)
    for seed in (7, 100):
        todo.append({"leg": "c3", "steps": 12, "textureSize": 4096, "subject": "bulma", "seed": seed})
    todo = [r for r in todo if key_of(r) not in done]

    if todo:
        print(f"{len(todo)} gen samples to run")
        t0 = time.perf_counter()
        pipeline = t2._load_pipeline(WEIGHTS, low_vram=True)
        print(f"pipeline loaded in {time.perf_counter() - t0:.1f}s")
        images = {n: t2._require_rgba(p) for n, p in SUBJECTS.items()}
        for i, r in enumerate(todo):
            torch.cuda.synchronize()
            t = time.perf_counter()
            try:
                mesh = pipeline.run(
                    images[r["subject"]],
                    seed=r["seed"],
                    pipeline_type=TIER,
                    preprocess_image=True,
                    sparse_structure_sampler_params={
                        "steps": r["steps"], "guidance_strength": 7.5,
                    },
                    shape_slat_sampler_params={"steps": r["steps"], "guidance_strength": 7.5},
                    tex_slat_sampler_params={
                        "steps": r["steps"],
                        "guidance_strength": GUIDANCE,
                        "guidance_rescale": RESCALE,
                    },
                )[0]
            except Exception as err:  # noqa: BLE001
                record({**r, "error": f"{type(err).__name__}: {err}"})
                print(f"[{i + 1}/{len(todo)}] {key_of(r)} ERROR {err}")
                torch.cuda.empty_cache()
                continue
            d = OUT / f"{r['leg']}_s{r['steps']}_t{r['textureSize']}_{r['subject']}_seed{r['seed']}"
            d.mkdir(exist_ok=True)
            t2._export_glb(mesh, d / "mesh.glb", texture_size=r["textureSize"], decimation=200000)
            exported = rt.as_mesh(rt._load_mesh(d / "mesh.glb"))
            exported.visual.material.baseColorTexture.save(d / "basecolor.png")
            st = texture_stats(exported)
            row = {
                **r,
                **st["tex"],
                "texRes": st["texRes"],
                "metal": st["metal"],
                "hueDist": round(
                    float(
                        np.hypot(
                            st["tex"]["a"] - src[r["subject"]]["a"],
                            st["tex"]["b"] - src[r["subject"]]["b"],
                        )
                    ),
                    4,
                ),
                "wallSeconds": round(time.perf_counter() - t, 1),
            }
            record(row)
            print(
                f"[{i + 1}/{len(todo)}] {key_of(r)} hue {row['hueDist']} metal {row['metal']} "
                f"texRes {row['texRes']} {row['wallSeconds']}s"
            )
            del mesh, exported
            torch.cuda.empty_cache()

        # C4: the flattened (no-alpha) variant, expected to REFUSE at the
        # adapter's own gate (_require_rgba demands alpha) - the pin is the
        # refusal text itself
        c4_key = "c4|12|2048|bulma-flattened|7"
        if c4_key not in done:
            try:
                t2._require_rgba(flat_path)
                outcome = "ACCEPTED (unexpected - the gate did not fire)"
            except Exception as err:  # noqa: BLE001
                outcome = f"REFUSED: {type(err).__name__}: {err}"
            with jsonl.open("a", encoding="utf-8") as f:
                f.write(
                    json.dumps(
                        {
                            "leg": "c4",
                            "steps": 12,
                            "textureSize": 2048,
                            "subject": "bulma-flattened",
                            "seed": 7,
                            "outcome": outcome,
                        }
                    ) + "\n"
                )
            print(f"C4 flattened: {outcome}")

    print("C WAVE COMPLETE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
