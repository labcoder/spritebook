"""Contact sheet for the guidance sweep: one row per strength, judged by eye.

The numbers in sweep.json say saturation rose. Only the pictures say whether it
rose into "looks like the reference" or into "looks oversaturated", which is the
failure mode of turning classifier-free guidance up too far — so the sheet puts
the source at the head of every row rather than in a corner.

  uv run --project sidecar python spikes/trellis2/sweep_sheet.py
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spikes/trellis2/out/guidance_sweep"
T = 232


def label(card: Image.Image, text: str, sub: str, tone=(150, 200, 255)) -> Image.Image:
    d = ImageDraw.Draw(card)
    d.text((6, T + 4), text, fill=(235, 235, 235))
    d.text((6, T + 22), sub, fill=tone)
    return card


def cell(img: Image.Image, text: str, sub: str, tone=(150, 200, 255)) -> Image.Image:
    card = Image.new("RGB", (T, T + 44), (18, 18, 20))
    card.paste(img.convert("RGB").resize((T, T), Image.LANCZOS), (0, 0))
    return label(card, text, sub, tone)


def main() -> int:
    data = json.loads((OUT / "sweep.json").read_text(encoding="utf-8"))
    runs = data["runs"]
    src_sat = data["sourceSaturation"]
    strengths = sorted({r["guidanceStrength"] for r in runs})
    seeds = sorted({r["seed"] for r in runs})

    src = Image.open(data["image"])
    flat = Image.new("RGB", src.size, (18, 18, 20))
    flat.paste(src, mask=src.split()[3])

    rows = []
    for s in strengths:
        cells = [cell(flat, "SOURCE", f"sat {src_sat:.3f}", (200, 200, 200))]
        for seed in seeds:
            r = next(x for x in runs if x["guidanceStrength"] == s and x["seed"] == seed)
            img = Image.open(OUT / f"g{s:g}_s{seed}" / "basecolor.png")
            met = r.get("metallicMean", float("nan"))
            bad = met > 0.5 or r["collapse"] is not None
            cells.append(cell(
                img,
                f"guidance {s:g}   seed {seed}",
                f"sat {r['saturation']:.3f}   metal {met:.2f}",
                (255, 140, 140) if bad else (150, 255, 170),
            ))
        rows.append(cells)

    w = T * len(rows[0]) + 8 * (len(rows[0]) + 1)
    h = (T + 44) * len(rows) + 8 * (len(rows) + 1)
    sheet = Image.new("RGB", (w, h), (10, 10, 12))
    for ri, cells in enumerate(rows):
        for ci, c in enumerate(cells):
            sheet.paste(c, (8 + ci * (T + 8), 8 + ri * (T + 44 + 8)))
    dest = OUT.parent / "guidance_sweep_sheet.png"
    sheet.save(dest)
    print("wrote", dest, sheet.size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
