"""
Chroma-key a flat green-screen reference to RGBA, with despill.

Not the production path — production runs our catalogued u2net (Apache-2.0) —
but for a FLAT key colour a chroma key is both more accurate and one less
variable in a test that is about TRELLIS.2's geometry, not our cutout.

Despill matters more than it looks: green fringing survives into the generated
PBR base colour, so a character keyed without it comes back with a faint green
rim baked into the texture, and that is not something you can fix downstream.
"""
import argparse
import os

import numpy as np
from PIL import Image


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--out', required=True)
    ap.add_argument('--tol', type=float, default=0.42, help='key tolerance 0..1')
    args = ap.parse_args()

    im = Image.open(args.image).convert('RGB')
    a = np.asarray(im).astype(np.float32) / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]

    # "how green is this pixel relative to its other channels" — robust to the
    # backdrop's own shading, unlike an exact-colour match
    greenness = g - np.maximum(r, b)
    alpha = np.clip(1.0 - greenness / max(args.tol, 1e-6), 0.0, 1.0)

    # Despill: pull green down to the neighbouring channels wherever it exceeds
    # them, so edge pixels stop carrying the backdrop into the texture.
    spill = np.maximum(g - np.maximum(r, b), 0.0)
    g2 = g - spill
    out = np.stack([r, g2, b], axis=-1)

    # unpremultiply-safe: fully keyed pixels carry no colour at all
    out[alpha <= 0.001] = 0.0

    rgba = np.concatenate([out, alpha[..., None]], axis=-1)
    rgba = (np.clip(rgba, 0, 1) * 255.0 + 0.5).astype(np.uint8)
    img = Image.fromarray(rgba, mode='RGBA')

    # crop to the subject with a small margin — TRELLIS.2 resizes to 512 and a
    # character occupying 40% of the frame throws away half its resolution
    bbox = img.split()[-1].getbbox()
    if bbox:
        pad = int(0.04 * max(img.size))
        x0, y0, x1, y1 = bbox
        img = img.crop((max(0, x0 - pad), max(0, y0 - pad),
                        min(img.size[0], x1 + pad), min(img.size[1], y1 + pad)))
        # square it so the resize does not change the aspect
        w, h = img.size
        s = max(w, h)
        sq = Image.new('RGBA', (s, s), (0, 0, 0, 0))
        sq.paste(img, ((s - w) // 2, (s - h) // 2))
        img = sq

    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    img.save(args.out)
    op = int((np.asarray(img)[..., 3] > 8).sum())
    print(f'{args.image} -> {args.out}  {img.size}  {op:,} opaque px '
          f'({100.0 * op / (img.size[0] * img.size[1]):.1f}% of frame)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
