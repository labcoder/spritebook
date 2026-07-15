/**
 * The quantize bridge: pool → palette → Sx labels (with dither) → 1x hysteresis.
 * Pairs Agent A's palette core with the pipeline. The adaptive palette is built
 * ONCE per character from every opaque pixel across all frames (skill: per-frame
 * palettes guarantee flicker).
 *
 * eps unit (Agent A flagged this): OKLab distances here are SQUARED, but
 * StylePreset.temporal.paletteHysteresisEps is a LINEAR OKLab delta (~1 JND at
 * 0.02), so it is squared at the call site before hysteresis compares squared
 * distances. Recorded as a local decision in docs/internal/decisions.md.
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

/** Build the character palette once: adaptive from the pool, or fixed from hex. */
export function buildPalette(preset: StylePreset, litFrames: Uint8Array[]): Palette {
  const q = preset.quantize;
  if (!q) return { srgb: new Uint8Array(0), lab: new Float32Array(0), size: 0 };
  if (Array.isArray(q.palette)) return paletteFromHex(q.palette);
  return buildAdaptivePalette(poolOklab(litFrames), q.maxColors);
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
 */
export function labelSx(
  rgba: Uint8Array,
  width: number,
  height: number,
  palette: Palette,
  dither: DitherConfig | null,
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
        const d = (bayerValue(dither.matrix, dither.size, x, y) - 0.5) * dither.strength *
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
  const eps2 = epsLinear * epsLinear;
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
    const candDist = dist2ToIndex(lab, palette, c);
    const prevDist = dist2ToIndex(lab, palette, prevLabel);
    out[p] = hysteresis(prevLabel, c, prevDist, candDist, eps2);
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
