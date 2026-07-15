/**
 * Deterministic adaptive palette (median cut in OKLab), nearest-match, and
 * temporal hysteresis for the NPR quantize stage (P2-T2). Pure CPU — no GPU, no
 * image IO.
 *
 * Determinism is a pipeline law (AGENTS.md invariant 8; skill: "same inputs ->
 * identical palette assignment, byte for byte"). Median cut uses a fixed split
 * rule with no RNG:
 *   1. split the box with the largest OKLab axis-range (extent); ties -> lowest
 *      box index;
 *   2. split along that box's longest axis; ties -> lowest axis (L < a < b);
 *   3. partition at the COUNT median of a stable sort keyed on (axis value, then
 *      sample index) — both halves are non-empty, and the order is fixed.
 * The final palette order is the box order after all splits (a split replaces
 * its box in place with {left, right}). Same pooledLab -> byte-identical Palette.
 *
 * The palette is built ONCE per character over the OKLab of every opaque pixel
 * pooled across all frames (skill: per-frame palettes guarantee flicker). Both
 * constructors preserve the invariant `lab[i] === srgbToLab(srgb[i])`, so
 * nearest-match measures distance to the color actually written to the sprite.
 */
import type { Lab, Palette } from './contracts.ts';
import { oklabToSrgb, srgbToLab } from './oklab.ts';

/** Build a Palette from parallel sRGB bytes, deriving `lab` so it stays consistent. */
function paletteFromSrgb(srgb: Uint8Array): Palette {
  const size = Math.floor(srgb.length / 3);
  const lab = new Float32Array(size * 3);
  for (let i = 0; i < size; i++) {
    const [L, a, b] = srgbToLab(srgb[i * 3], srgb[i * 3 + 1], srgb[i * 3 + 2]);
    lab[i * 3] = L;
    lab[i * 3 + 1] = a;
    lab[i * 3 + 2] = b;
  }
  return { srgb, lab, size };
}

/** Longest OKLab axis of a box's samples and its extent. Ties -> lowest axis. */
function longestAxis(
  pooled: Float32Array,
  members: number[],
): { axis: number; extent: number } {
  let bestAxis = 0;
  let bestExtent = -1;
  for (let axis = 0; axis < 3; axis++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const idx of members) {
      const v = pooled[idx * 3 + axis];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const extent = hi - lo;
    if (extent > bestExtent) {
      bestExtent = extent;
      bestAxis = axis;
    }
  }
  return { axis: bestAxis, extent: bestExtent };
}

/**
 * Median-cut adaptive palette. `pooledLab` is K*3 OKLab samples (all opaque
 * pixels pooled across every frame). Returns a palette of at most `maxColors`
 * entries; each entry is the sRGB of its box's mean OKLab.
 */
export function buildAdaptivePalette(pooledLab: Float32Array, maxColors: number): Palette {
  const k = Math.floor(pooledLab.length / 3);
  if (k === 0) return { srgb: new Uint8Array(0), lab: new Float32Array(0), size: 0 };

  const first: number[] = [];
  for (let i = 0; i < k; i++) first.push(i);
  const boxes: number[][] = [first];

  while (boxes.length < maxColors) {
    // Pick the splittable box with the largest extent; ties -> lowest index.
    let target = -1;
    let targetExtent = 0;
    for (let i = 0; i < boxes.length; i++) {
      const { extent } = longestAxis(pooledLab, boxes[i]);
      if (extent > targetExtent) {
        targetExtent = extent;
        target = i;
      }
    }
    if (target < 0) break; // every box is a single OKLab point — nothing to split

    const members = boxes[target];
    const { axis } = longestAxis(pooledLab, members);
    const sorted = members.slice().sort((p, q) => {
      const dv = pooledLab[p * 3 + axis] - pooledLab[q * 3 + axis];
      return dv !== 0 ? dv : p - q; // total order -> stable regardless of engine
    });
    const mid = sorted.length >> 1; // floor(n/2), in [1, n-1] for n >= 2
    boxes.splice(target, 1, sorted.slice(0, mid), sorted.slice(mid));
  }

  const srgb = new Uint8Array(boxes.length * 3);
  for (let i = 0; i < boxes.length; i++) {
    const members = boxes[i];
    let sumL = 0;
    let sumA = 0;
    let sumB = 0;
    for (const idx of members) {
      sumL += pooledLab[idx * 3];
      sumA += pooledLab[idx * 3 + 1];
      sumB += pooledLab[idx * 3 + 2];
    }
    const n = members.length;
    const [r, g, b] = oklabToSrgb([sumL / n, sumA / n, sumB / n]);
    srgb[i * 3] = r;
    srgb[i * 3 + 1] = g;
    srgb[i * 3 + 2] = b;
  }
  return paletteFromSrgb(srgb);
}

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

/** Fixed-palette mode: parse `#rrggbb` strings to sRGB and precompute OKLab. */
export function paletteFromHex(hex: string[]): Palette {
  const srgb = new Uint8Array(hex.length * 3);
  for (let i = 0; i < hex.length; i++) {
    const match = HEX_RE.exec(hex[i].trim());
    if (!match) {
      throw new Error(`paletteFromHex: invalid '#rrggbb' color: ${JSON.stringify(hex[i])}`);
    }
    const n = parseInt(match[1], 16);
    srgb[i * 3] = (n >> 16) & 0xff;
    srgb[i * 3 + 1] = (n >> 8) & 0xff;
    srgb[i * 3 + 2] = n & 0xff;
  }
  return paletteFromSrgb(srgb);
}

/**
 * Nearest palette entry to `lab` and its squared OKLab distance. Deterministic
 * tie-break: lowest index. An empty palette returns `{ index: -1, dist: Inf }`.
 */
export function nearestWithDist(palette: Palette, lab: Lab): { index: number; dist: number } {
  const pl = palette.lab;
  let bestIndex = -1;
  let bestDist = Infinity;
  for (let i = 0; i < palette.size; i++) {
    const dL = pl[i * 3] - lab[0];
    const dA = pl[i * 3 + 1] - lab[1];
    const dB = pl[i * 3 + 2] - lab[2];
    const dist = dL * dL + dA * dA + dB * dB;
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }
  return { index: bestIndex, dist: bestDist };
}

/** Index of the nearest palette entry (squared OKLab distance); ties -> lowest index. */
export function nearestIndex(palette: Palette, lab: Lab): number {
  return nearestWithDist(palette, lab).index;
}

/**
 * Palette hysteresis: keep the previous frame's index unless the new candidate
 * improves perceptual distance by more than `eps` (kills single-pixel
 * oscillation on gradients — skill temporal toolkit). Distances are SQUARED
 * OKLab; `prevDist` is the current pixel's distance to `palette[prevIndex]`,
 * `candDist` is `nearestWithDist(...).dist`. No history (prevIndex < 0) -> cand.
 */
export function hysteresis(
  prevIndex: number,
  candIndex: number,
  prevDist: number,
  candDist: number,
  eps: number,
): number {
  if (prevIndex < 0) return candIndex;
  return prevDist - candDist > eps ? candIndex : prevIndex;
}
