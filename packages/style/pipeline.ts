/**
 * The NPR pipeline spine — the ORDER IS LAW (npr-sprite-stylization skill). Per
 * frame: composite the outline color into the Sx lit (display space) → quantize
 * to Sx labels with position-locked Bayer dither → cluster-vote Sx→1x (or
 * area-average for painterly) → palette hysteresis vs the previous frame → 1-bit
 * alpha + edge bleed. The adaptive palette is built ONCE across all frames, and
 * lighting is constant per clip (frozen in the render). Compositing the outline
 * as COLOR (not just a label) means the vote AND the hysteresis reference both
 * see dark at stroke texels, so strokes survive downsampling and hysteresis
 * never pins an outline pixel to a stale surface color.
 *
 * styleFromAovs is pure CPU over committed AOV PNGs, so it is deterministic and
 * runs anywhere; the GPU-touching runStyleJob (mod.ts) renders the AOVs first.
 */
import { encode as encodePng } from 'fast-png';
import type { CameraPreset, QAFlag, StylePreset } from '@spritebook/schema';
import type { AovImage, AovSource, Palette, StyleResult } from './contracts.ts';
import { readAov } from './aovio.ts';
import { extractOutline } from './outline.ts';
import { areaAverageDownsample, clusterVoteDownsample, downsampleCoverage } from './downsample.ts';
import {
  buildPalette,
  darkestIndex,
  type DitherConfig,
  labelsToRgba,
  labelSx,
  resolveHysteresis,
} from './quantize.ts';
import { bayerMatrix } from './dither.ts';
import { cutAlpha1bit, dilateEdgeColors } from './alpha.ts';
import { flickerPct } from './flicker.ts';
import { srgbToHex } from './oklab.ts';

function tag(direction: number, frame: number): string {
  return `d${String(direction).padStart(2, '0')}_f${String(frame).padStart(3, '0')}`;
}

function outlineColor(style: StylePreset, palette: Palette): [number, number, number] {
  const from = style.outline!.colorFrom;
  if (from === 'palette-dark') {
    const i = darkestIndex(palette) * 3;
    return [palette.srgb[i], palette.srgb[i + 1], palette.srgb[i + 2]];
  }
  const h = from.replace(/^#/, '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function ditherConfig(style: StylePreset): DitherConfig | null {
  const d = style.quantize?.dither;
  if (!d || d.kind !== 'ordered') return null;
  return { matrix: bayerMatrix(d.matrix), size: d.matrix, strength: d.strength };
}

/** Composite the outline color into a COPY of the Sx lit; returns the copy. */
function composite(aov: AovImage, style: StylePreset, color: [number, number, number]): Uint8Array {
  const out = aov.lit.slice();
  if (!style.outline) return out;
  const mask = extractOutline(aov, {
    superSample: style.temporal.superSample,
    widthPx: style.outline.widthPx,
    normalThreshold: style.outline.normalThreshold,
    depthThresholdScaled: style.outline.depthThresholdScaled,
  });
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const o = p * 4;
    out[o] = color[0];
    out[o + 1] = color[1];
    out[o + 2] = color[2];
  }
  return out;
}

/** One frame Sx → 1x styled rgba (pre-alpha-finish) + its 1x labels (for hysteresis carry). */
function processFrame(
  aov: AovImage,
  style: StylePreset,
  palette: Palette,
  color: [number, number, number],
  dither: DitherConfig | null,
  prev: Int32Array | null,
): { rgba: Uint8Array; labels: Int32Array | null } {
  const s = style.temporal.superSample;
  const w1 = aov.width / s, h1 = aov.height / s;
  const comp = composite(aov, style, color);
  const cov1 = downsampleCoverage(
    Uint8Array.from({ length: aov.width * aov.height }, (_v, i) => comp[i * 4 + 3]),
    aov.width,
    aov.height,
    s,
  );

  if (style.temporal.clusterVote) {
    // blockSize = s: the Bayer dither is indexed by the 1x output block, so it
    // survives the vote instead of being averaged away (M3).
    const labelsSx = labelSx(comp, aov.width, aov.height, palette, dither, s);
    const cand = clusterVoteDownsample(labelsSx, aov.width, aov.height, s);
    const ref = areaAverageDownsample(comp, aov.width, aov.height, s);
    const final = resolveHysteresis(
      cand,
      ref,
      prev,
      palette,
      style.temporal.paletteHysteresisEps,
      w1,
      h1,
    );
    return { rgba: labelsToRgba(final, cov1, palette, w1, h1), labels: final };
  }

  // painterly: area-average, then (if a palette exists) quantize the 1x color
  const avg = areaAverageDownsample(comp, aov.width, aov.height, s);
  if (palette.size > 0) {
    const cand = labelSx(avg, w1, h1, palette, dither);
    const final = resolveHysteresis(
      cand,
      avg,
      prev,
      palette,
      style.temporal.paletteHysteresisEps,
      w1,
      h1,
    );
    return { rgba: labelsToRgba(final, cov1, palette, w1, h1), labels: final };
  }
  const rgba = avg.slice();
  for (let p = 0; p < w1 * h1; p++) rgba[p * 4 + 3] = cov1[p];
  return { rgba, labels: null };
}

function finishAlpha(rgba: Uint8Array, style: StylePreset, w: number, h: number): void {
  if (style.alpha.mode === '1bit' && style.alpha.cutoff !== undefined) {
    cutAlpha1bit(rgba, style.alpha.cutoff);
  }
  if (style.alpha.bleedPx > 0) dilateEdgeColors(rgba, w, h, style.alpha.bleedPx);
}

function qaFlags(style: StylePreset, camera: CameraPreset): QAFlag[] {
  const flags: QAFlag[] = [];
  if (style.outline && style.outline.widthPx > camera.paddingPx) {
    // preset-config check (a single representative frameRef; the flag is global,
    // not per-frame). Strokes grow inward so they don't clip, but exceeding the
    // padding budget means the outline eats into the cell's bleed margin.
    flags.push({
      code: 'outline-exceeds-padding',
      severity: 'warn',
      sourceStage: 'look',
      frameRefs: [{ clipId: 'idle', direction: 0, frame: 0 }],
      message:
        `outline width ${style.outline.widthPx}px exceeds the ${camera.paddingPx}px padding budget; ` +
        `reduce widthPx or increase the camera padding`,
    });
  }
  return flags;
}

function paletteToHex(palette: Palette): string[] {
  const out: string[] = [];
  for (let i = 0; i < palette.size; i++) {
    out.push(srgbToHex(palette.srgb[i * 3], palette.srgb[i * 3 + 1], palette.srgb[i * 3 + 2]));
  }
  return out;
}

/**
 * Style a directory of Sx AOVs into 1x sprite PNGs + a StyleResult. Pure CPU:
 * reads the committed AOVs, builds the palette once, runs the law-order pipeline
 * per direction (hysteresis carries within a direction's frame loop), writes
 * `${outDir}/styled/dDD_fFFF.png`, and reports the flicker metric + QA flags.
 */
export async function styleFromAovs(
  src: AovSource,
  camera: CameraPreset,
  style: StylePreset,
  outDir: string,
): Promise<StyleResult> {
  const s = style.temporal.superSample;
  const w1 = src.width / s, h1 = src.height / s;

  // read every AOV; pool lit for the once-per-character palette
  const aovs: AovImage[][] = [];
  const allLit: Uint8Array[] = [];
  for (let d = 0; d < src.directions; d++) {
    aovs[d] = [];
    for (let f = 0; f < src.frames; f++) {
      const aov = await readAov(src.framesDir, d, f);
      aovs[d][f] = aov;
      allLit.push(aov.lit);
    }
  }

  const palette = buildPalette(style, allLit);
  const color = style.outline
    ? outlineColor(style, palette)
    : [0, 0, 0] as [number, number, number];
  const dither = ditherConfig(style);

  const styledDir = `${outDir}/styled`;
  await Deno.mkdir(styledDir, { recursive: true });

  const idleFrames: Uint8Array[] = []; // direction 0's styled frames, for flicker
  for (let d = 0; d < src.directions; d++) {
    let prev: Int32Array | null = null;
    for (let f = 0; f < src.frames; f++) {
      const { rgba, labels } = processFrame(aovs[d][f], style, palette, color, dither, prev);
      prev = labels;
      finishAlpha(rgba, style, w1, h1);
      if (d === 0) idleFrames.push(rgba.slice());
      await Deno.writeFile(
        `${styledDir}/${tag(d, f)}.png`,
        encodePng({ width: w1, height: h1, data: rgba }),
      );
    }
  }

  return {
    stylePresetId: style.id,
    cameraPresetId: camera.id,
    directions: src.directions,
    frames: src.frames,
    cellPx: { w: w1, h: h1 },
    superSample: s,
    paletteHex: paletteToHex(palette),
    flickerPct: flickerPct(idleFrames, w1, h1),
    flags: qaFlags(style, camera),
    styledDir,
  };
}
