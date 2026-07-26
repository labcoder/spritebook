/**
 * Sx -> 1x AOV cell downsampling (P2-T3). The style stage owns the LIT 1x cell (its
 * cluster-vote pipeline); the bake still needs 1x albedo/normal/depth/mask cells to
 * composite AOV pages, and each AOV declares its own reduction (contracts.ts):
 *
 *   albedo  rgba8   AREA-AVERAGE   it is a color; the block mean per channel INCLUDING
 *                                  alpha, round-half-up in integer math
 *   normal  rgba8   CENTER-TAP     data AOV — averaged normals are not unit vectors
 *   depth   gray16  CENTER-TAP     data AOV — averaged depths invent surfaces
 *   mask    gray16  CENTER-TAP     coverage is 0 or 1 and must NEVER blend
 *
 * Center-tap picks the (floor(s/2), floor(s/2)) subpixel of each s x s block — a fixed,
 * deterministic representative, no filtering. Everything here is integer math in fixed
 * iteration order: no floats, no clock, no randomness.
 */
import type { AovImage } from '@spritebook/style';
import type { Aov1xCells } from './contracts.ts';

/** Throw unless `buf` holds exactly `expected` elements (guards a mis-sized AovImage). */
function assertLength(name: string, len: number, expected: number): void {
  if (len !== expected) {
    throw new RangeError(`${name} length ${len} does not match the Sx grid (expected ${expected})`);
  }
}

/**
 * Downsample one frame's Sx AOV planes to 1x cell planes. Throws RangeError unless s is
 * a positive integer that divides both width and height evenly.
 */
export function aov1x(aov: AovImage, s: number): Aov1xCells {
  if (!Number.isInteger(s) || s < 1) {
    throw new RangeError(`supersample factor s must be a positive integer, got ${s}`);
  }
  const { width, height } = aov;
  if (width % s !== 0 || height % s !== 0) {
    throw new RangeError(
      `Sx dims ${width}x${height} must both be divisible by supersample factor ${s}`,
    );
  }
  assertLength('albedo', aov.albedo.length, width * height * 4);
  assertLength('normal', aov.normal.length, width * height * 4);
  assertLength('depth', aov.depth.length, width * height);
  assertLength('mask', aov.mask.length, width * height);

  const w = width / s;
  const h = height / s;
  const area = s * s;
  const half = area >> 1; // round-half-up bias; exact for even area, no .5 ties for odd
  const c = s >> 1; // center-tap offset floor(s/2)

  const albedo = new Uint8Array(w * h * 4);
  const normal = new Uint8Array(w * h * 4);
  const depth = new Uint16Array(w * h);
  const mask = new Uint16Array(w * h);

  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      const baseY = oy * s;
      const baseX = ox * s;

      // albedo: colour weighted BY coverage, alpha as the area mean. Summing
      // r,g,b over cleared (0,0,0,0) subpixels and dividing by the full area
      // mixes transparent black into every edge texel — the same defect
      // style/downsample.ts carried, and it lands here on the shipped 1x
      // albedo pages. A fully covered block is unchanged (the weight factors
      // out); only partial-coverage edges move.
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < s; dy++) {
        let idx = ((baseY + dy) * width + baseX) * 4;
        for (let dx = 0; dx < s; dx++) {
          const w8 = aov.albedo[idx + 3];
          r += aov.albedo[idx] * w8;
          g += aov.albedo[idx + 1] * w8;
          b += aov.albedo[idx + 2] * w8;
          a += w8;
          idx += 4;
        }
      }
      const o = (oy * w + ox) * 4;
      if (a > 0) {
        const bias = a >> 1;
        albedo[o] = ((r + bias) / a) | 0;
        albedo[o + 1] = ((g + bias) / a) | 0;
        albedo[o + 2] = ((b + bias) / a) | 0;
        albedo[o + 3] = ((a + half) / area) | 0;
      } // else: nothing covered, leave (0,0,0,0)

      // normal / depth / mask: the center subpixel, untouched
      const tap = (baseY + c) * width + baseX + c;
      const tap4 = tap * 4;
      normal[o] = aov.normal[tap4];
      normal[o + 1] = aov.normal[tap4 + 1];
      normal[o + 2] = aov.normal[tap4 + 2];
      normal[o + 3] = aov.normal[tap4 + 3];
      depth[oy * w + ox] = aov.depth[tap];
      mask[oy * w + ox] = aov.mask[tap];
    }
  }

  return {
    albedo: { w, h, rgba: albedo },
    normal: { w, h, rgba: normal },
    depth: { w, h, gray16: depth },
    mask: { w, h, gray16: mask },
  };
}
