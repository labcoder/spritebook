/**
 * Deterministic adaptive palette (median cut in OKLab), nearest-match, and
 * temporal hysteresis for the NPR quantize stage (P2-T2). Pure CPU — no GPU, no
 * image IO.
 *
 * Determinism is a pipeline law (AGENTS.md invariant 8; skill: "same inputs ->
 * identical palette assignment, byte for byte"). Median cut uses a fixed split
 * rule with no RNG:
 *   1. split the box with the largest POPULATION x EXTENT; ties -> lowest box
 *      index. Weighting by population is what keeps a slot from being spent on
 *      three stray pixels while the dense spread cluster stays one colour;
 *   2. split along that box's longest axis; ties -> lowest axis (L < a < b);
 *   3. partition at the COUNT median of a stable sort keyed on (axis value, then
 *      sample index) — both halves are non-empty, and the order is fixed.
 * Splitting continues until the boxes contribute `maxColors` DISTINCT sRGB
 * triples (not merely `maxColors` boxes — two boxes can round to one colour,
 * and the duplicate is a slot the sprite can never use). The final palette order
 * is the box order after all splits, deduped. Same pooledLab -> byte-identical
 * Palette.
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

/** The sRGB of a box's mean OKLab — the colour that box contributes. */
function boxColor(pooledLab: Float32Array, members: number[]): [number, number, number] {
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  for (const idx of members) {
    sumL += pooledLab[idx * 3];
    sumA += pooledLab[idx * 3 + 1];
    sumB += pooledLab[idx * 3 + 2];
  }
  const n = members.length;
  return oklabToSrgb([sumL / n, sumA / n, sumB / n]);
}

/**
 * How many boxes contribute a DISTINCT sRGB triple. This — not the box count —
 * is the palette a sprite is actually painted with: `nearestWithDist` breaks
 * ties with a strict `<`, so a duplicate entry can never be selected and is a
 * dead slot.
 */
function distinctCount(colors: [number, number, number][]): number {
  const seen = new Set<number>();
  for (const [r, g, b] of colors) seen.add((r << 16) | (g << 8) | b);
  return seen.size;
}

/**
 * Bound on how far past `maxColors` the box count may go while chasing distinct
 * colours. Splitting always terminates on its own (every box eventually holds a
 * single sample), but "eventually" is one box per pooled pixel, so the search
 * needs a ceiling. Reaching it means the pool genuinely cannot fill the
 * palette, and the honest smaller palette is the right answer.
 */
const BOX_BUDGET = 8;

/**
 * Median-cut adaptive palette. `pooledLab` is K*3 OKLab samples (all opaque
 * pixels pooled across every frame). Returns a palette of at most `maxColors`
 * entries, every one of them DISTINCT.
 *
 * Splitting is driven by the distinct-colour count rather than the box count,
 * because those two are not the same thing and the difference was shipping:
 * `pixel-8` advertised eight tones and painted with four, `painterly`
 * thirty-two and painted with seven. A box selected on extent alone can be two
 * outliers around a dense cluster, and halving it at the count median yields
 * two boxes whose means round to the SAME sRGB triple — a split that costs a
 * palette slot and buys no colour.
 */
export function buildAdaptivePalette(pooledLab: Float32Array, maxColors: number): Palette {
  const k = Math.floor(pooledLab.length / 3);
  if (k === 0) return { srgb: new Uint8Array(0), lab: new Float32Array(0), size: 0 };

  const first: number[] = [];
  for (let i = 0; i < k; i++) first.push(i);
  const boxes: number[][] = [first];
  const colors: [number, number, number][] = [boxColor(pooledLab, first)];
  const ceiling = Math.max(maxColors, maxColors * BOX_BUDGET);

  while (distinctCount(colors) < maxColors && boxes.length < ceiling) {
    // Pick by POPULATION x EXTENT, not extent alone: a wide box holding three
    // stray pixels moves almost nothing, while the dense spread cluster is
    // where a new tone actually comes from. Ties -> lowest box index, so the
    // choice stays deterministic (AGENTS.md invariant 8).
    let target = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue; // a single sample cannot be split
      const { extent } = longestAxis(pooledLab, boxes[i]);
      const score = extent * boxes[i].length;
      if (score > best) {
        best = score;
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
    const left = sorted.slice(0, mid);
    const right = sorted.slice(mid);
    boxes.splice(target, 1, left, right);
    colors.splice(target, 1, boxColor(pooledLab, left), boxColor(pooledLab, right));
  }

  // Emit the DISTINCT colours in box order, capped. Reporting a duplicate
  // would be reporting a slot the sprite can never use — `paletteHex` feeds
  // palette.json and the membership check, so it has to be the truth.
  const out: number[] = [];
  const seen = new Set<number>();
  for (const [r, g, b] of colors) {
    const key = (r << 16) | (g << 8) | b;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r, g, b);
    if (seen.size === maxColors) break;
  }
  return paletteFromSrgb(Uint8Array.from(out));
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
