"""Metal rate and colour fidelity per subject, and a sheet to judge by eye.

Reads finished workspaces rather than running anything, so it can be re-run
against the same evidence without paying for the GPU again.

  uv run --project sidecar python spikes/trellis2/cross_report.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spikes/trellis2/out"

# (workspace, reference, style, in TRELLIS.2's own example set)
SUBJECTS = [
    (OUT / "verb-e2e/bulma", "bulma-front", "flat anime line art", False),
    (OUT / "cross-subject/painted-mermaid", "painted-mermaid", "painted illustration", True),
    (OUT / "cross-subject/lineless-princess", "lineless-princess", "lineless soft 3D", True),
    (OUT / "cross-subject/robot-astro", "robot-astro", "glossy 3D robot", False),
]


def source_saturation(ref: str) -> tuple[float, Image.Image]:
    im = Image.open(REPO / f"spikes/trellis2/refs/{ref}.png").convert("RGBA")
    a = np.asarray(im, dtype=np.float32) / 255.0
    fg = a[:, :, 3] > 0.5
    sat = float((a[:, :, :3][fg].max(-1) - a[:, :, :3][fg].min(-1)).mean())
    flat = Image.new("RGB", im.size, (18, 18, 20))
    flat.paste(im, mask=im.split()[3])
    return sat, flat


def measure(glb: Path) -> dict | None:
    if not glb.is_file():
        return None
    m = trimesh.load(str(glb), process=False)
    g = list(m.geometry.values())[0] if isinstance(m, trimesh.Scene) else m
    bc = np.asarray(g.visual.material.baseColorTexture.convert("RGB"), dtype=np.float32) / 255.0
    lit = bc.sum(-1) > 0.02
    mr = getattr(g.visual.material, "metallicRoughnessTexture", None)
    metal = 0.0
    if mr is not None:
        a = np.asarray(mr.convert("RGB"), dtype=np.float32) / 255.0
        ml = a.sum(-1) > 0.02
        metal = float((a[:, :, 2][ml] > 0.5).mean()) if ml.any() else 0.0
    return {
        "metal": metal,
        "saturation": float((bc[lit].max(-1) - bc[lit].min(-1)).mean()),
        "base": float(bc[lit].mean()),
        "texture": g.visual.material.baseColorTexture,
    }


def main() -> int:
    T = 250
    rows: list[list[Image.Image]] = []
    table: list[dict] = []

    for ws, ref, style, in_set in SUBJECTS:
        src_sat, src_img = source_saturation(ref)
        cells = [cell(src_img, T, f"{ref}", f"{style} · sat {src_sat:.3f}", (200, 200, 200))]
        for rid in ["r1", "r2", "r3", "r4", "r5"]:
            d = measure(ws / f"results/{rid}/model.glb")
            if d is None:
                continue
            meta_p = ws / f"results/{rid}/gen-meta.json"
            meta = json.loads(meta_p.read_text()) if meta_p.is_file() else {}
            tried = meta.get("seedsTried", [])
            op = "gen" if rid == "r1" else "retexture"
            table.append({
                "subject": ref, "style": style, "inExampleSet": in_set, "result": rid,
                "op": op, "metal": round(d["metal"], 3),
                "saturation": round(d["saturation"], 3), "sourceSaturation": round(src_sat, 3),
                "attempts": len(tried), "seedsTried": tried,
            })
            bad = d["metal"] > 0.60
            cells.append(cell(
                d["texture"], T, f"{rid}  {op}",
                f"metal {d['metal']:.0%}  sat {d['saturation']:.3f}  x{len(tried) or 1}",
                (255, 140, 140) if bad else (150, 255, 170),
            ))
        rows.append(cells)

    (OUT / "cross_subject.json").write_text(json.dumps(table, indent=2) + "\n", encoding="utf-8")

    print(f"{'subject':19} {'style':22} {'set':4} {'res':4} {'op':10} "
          f"{'metal':>6} {'sat':>6} {'src':>6} {'try':>4}")
    for r in table:
        print(f"{r['subject']:19} {r['style']:22} {'yes' if r['inExampleSet'] else 'no':4} "
              f"{r['result']:4} {r['op']:10} {r['metal']:6.1%} {r['saturation']:6.3f} "
              f"{r['sourceSaturation']:6.3f} {r['attempts']:4}")

    rt = [r for r in table if r["op"] == "retexture"]
    gn = [r for r in table if r["op"] == "gen"]
    print(f"\nretexture majority-metal: {sum(1 for r in rt if r['metal'] > 0.6)}/{len(rt)}")
    print(f"generation majority-metal: {sum(1 for r in gn if r['metal'] > 0.6)}/{len(gn)}")
    for _, ref, _, _ in SUBJECTS:
        s = [r for r in rt if r["subject"] == ref]
        if s:
            print(f"  {ref:19} retexture metal {np.mean([r['metal'] for r in s]):.1%}  "
                  f"attempts {[r['attempts'] for r in s]}")

    width = max(len(r) for r in rows)
    W = T * width + 8 * (width + 1)
    H = (T + 42) * len(rows) + 8 * (len(rows) + 1)
    sheet = Image.new("RGB", (W, H), (10, 10, 12))
    for ri, cells in enumerate(rows):
        for ci, c in enumerate(cells):
            sheet.paste(c, (8 + ci * (T + 8), 8 + ri * (T + 42 + 8)))
    dest = OUT / "cross_subject_sheet.png"
    sheet.save(dest)
    print("\nwrote", dest, sheet.size)
    return 0


def cell(img: Image.Image, T: int, title: str, sub: str, tone) -> Image.Image:
    c = Image.new("RGB", (T, T + 42), (18, 18, 20))
    c.paste(img.convert("RGB").resize((T, T), Image.LANCZOS), (0, 0))
    d = ImageDraw.Draw(c)
    d.text((6, T + 4), title, fill=(235, 235, 235))
    d.text((6, T + 22), sub, fill=tone)
    return c


if __name__ == "__main__":
    raise SystemExit(main())
