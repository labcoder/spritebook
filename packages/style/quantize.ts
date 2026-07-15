/**
 * The quantize bridge: pool → palette → Sx labels (with dither) → 1x hysteresis.
 * Pairs Agent A's palette core with the pipeline. The adaptive palette is built
 * ONCE per character from every opaque pixel across all frames (skill: per-frame
 * palettes guarantee flicker).
 *
 * eps unit (D-021, corrected after review): paletteHysteresisEps is a LINEAR
 * OKLab delta (~1 JND at 0.02). hysteresis keeps prev unless `prevDist - candDist
 * > eps`; since that difference is `(√-diff)` of two distances, both distances
 * must be LINEAR and eps stays LINEAR. Squaring eps was wrong — with squared
 * distances `prevDist-candDist = (p-c)(p+c)` and `eps²` gives an effective band
 * of `eps²/(p+c)`, several-fold too narrow, so hysteresis barely engaged. We now
 * pass sqrt(distance) and the linear eps.
 */
import type { Lab, Palette } from './contracts.ts';
import type { StylePreset } from '@spritebook/schema';
import { srgbToLab } from './oklab.ts';
import { buildAdaptivePalette, hysteresis, nearestIndex, paletteFromHex } from './palette.ts';
import { bayerValue } from './dither.ts';

/** Pool OKLab of every opaque pixel across all Sx lit frames (surface colors). */
export function poolOklab(litFrames: Uint8Array[]): Float32Array {
  let k = 0;
  for (const f of litFrames) {
    for (let p = 0; p < f.length; p += 4) if (f[p + 3] > 0) k++;
  }
  const out = new Float32Array(k * 3);
  let o = 0;
  for (const f of litFrames) {
    for (let p = 0; p < f.length; p += 4) {
      if (f[p + 3] === 0) continue;
      const lab = srgbToLab(f[p], f[p + 1], f[p + 2]);
      out[o++] = lab[0];
      out[o++] = lab[1];
      out[o++] = lab[2];
    }
  }
  return out;
}

/**
 * Sort a palette by OKLab lightness ascending, so index 0 is the darkest entry.
 * The output colors are unchanged (only reindexed), but it makes the 'palette-
 * dark' outline label index 0, which wins cluster-vote ties (lowest index) — so
 * a half-phase boundary block resolves to the outline instead of an arbitrary
 * surface color, and thin strokes stop wobbling with sub-texel phase (M4).
 */
function sortByLightness(p: Palette): Palette {
  const order = Array.from({ length: p.size }, (_v, i) => i)
    .sort((a, b) => p.lab[a * 3] - p.lab[b * 3] || a - b);
  const srgb = new Uint8Array(p.size * 3);
  const lab = new Float32Array(p.size * 3);
  order.forEach((s, d) => {
    srgb.set(p.srgb.subarray(s * 3, s * 3 + 3), d * 3);
    lab.set(p.lab.subarray(s * 3, s * 3 + 3), d * 3);
  });
  return { srgb, lab, size: p.size };
}

/** Build the character palette once: adaptive from the pool, or fixed from hex. */
export function buildPalette(preset: StylePreset, litFrames: Uint8Array[]): Palette {
  const q = preset.quantize;
  if (!q) return { srgb: new Uint8Array(0), lab: new Float32Array(0), size: 0 };
  const built = Array.isArray(q.palette)
    ? paletteFromHex(q.palette)
    : buildAdaptivePalette(poolOklab(litFrames), q.maxColors);
  return sortByLightness(built);
}

/** Index of the darkest palette entry (lowest OKLab L) — the 'palette-dark' outline color. */
export function darkestIndex(palette: Palette): number {
  let best = 0, bestL = Infinity;
  for (let i = 0; i < palette.size; i++) {
    const l = palette.lab[i * 3];
    if (l < bestL) {
      bestL = l;
      best = i;
    }
  }
  return best;
}

function dist2ToIndex(lab: Lab, palette: Palette, i: number): number {
  const j = i * 3;
  const dL = lab[0] - palette.lab[j];
  const da = lab[1] - palette.lab[j + 1];
  const db = lab[2] - palette.lab[j + 2];
  return dL * dL + da * da + db * db;
}

export interface DitherConfig {
  matrix: Float32Array;
  size: number;
  strength: number;
}

// A dither perturbation of ±(strength/2)*SCALE in OKLab lightness, locked to
// pixel position (Bayer) so it stipples between palette entries without crawl.
const DITHER_L_SCALE = 0.1;

/**
 * Quantize an Sx rgba image to per-pixel palette labels (nearest OKLab entry),
 * with optional position-locked Bayer dither. Transparent texels (alpha 0) → -1.
 *
 * `blockSize` is the supersample factor: the Bayer threshold is indexed by the
 * OUTPUT (1x) block `(floor(x/blockSize), floor(y/blockSize))`, not the Sx pixel,
 * so all Sx subpixels of an output pixel share one threshold. Otherwise (matrix
 * == blockSize) every block sees the identical sub-tile and cluster-vote erases
 * the dither entirely; indexing by the 1x block makes adjacent output pixels
 * stipple between palette entries and survive the vote (M3).
 */
export function labelSx(
  rgba: Uint8Array,
  width: number,
  height: number,
  palette: Palette,
  dither: DitherConfig | null,
  blockSize = 1,
): Int32Array {
  const out = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const o = p * 4;
      if (rgba[o + 3] === 0) {
        out[p] = -1;
        continue;
      }
      const lab = srgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
      let match: Lab = lab;
      if (dither) {
        const bx = Math.floor(x / blockSize), by = Math.floor(y / blockSize);
        const d = (bayerValue(dither.matrix, dither.size, bx, by) - 0.5) * dither.strength *
          DITHER_L_SCALE;
        match = [lab[0] + d, lab[1], lab[2]];
      }
      out[p] = nearestIndex(palette, match);
    }
  }
  return out;
}

/**
 * Resolve 1x palette hysteresis: keep the previous frame's label unless this
 * frame's candidate improves the (squared) OKLab distance by more than eps.
 * `refRgba` is the 1x area-averaged color used to measure both distances, so an
 * outline pixel (whose composited ref color is dark) correctly favors the dark
 * label rather than being pinned to a stale surface color.
 */
export function resolveHysteresis(
  cand: Int32Array,
  refRgba: Uint8Array,
  prev: Int32Array | null,
  palette: Palette,
  epsLinear: number,
  width: number,
  height: number,
): Int32Array {
  const out = new Int32Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const c = cand[p];
    if (c < 0) {
      out[p] = -1;
      continue;
    }
    const prevLabel = prev ? prev[p] : -1;
    if (prevLabel < 0) {
      out[p] = c;
      continue;
    }
    const o = p * 4;
    const lab = srgbToLab(refRgba[o], refRgba[o + 1], refRgba[o + 2]);
    // LINEAR OKLab distances so `prevDist - candDist > epsLinear` is a true
    // linear-improvement test (D-021, corrected).
    const candDist = Math.sqrt(dist2ToIndex(lab, palette, c));
    const prevDist = Math.sqrt(dist2ToIndex(lab, palette, prevLabel));
    out[p] = hysteresis(prevLabel, c, prevDist, candDist, epsLinear);
  }
  return out;
}

/** 1x labels + coverage → straight-alpha rgba (palette color; coverage as alpha). */
export function labelsToRgba(
  labels: Int32Array,
  coverage: Uint8Array,
  palette: Palette,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const l = labels[p];
    if (l < 0) continue; // transparent
    const o = p * 4, j = l * 3;
    out[o] = palette.srgb[j];
    out[o + 1] = palette.srgb[j + 1];
    out[o + 2] = palette.srgb[j + 2];
    out[o + 3] = coverage[p];
  }
  return out;
}
