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
import { srgbToHex } from '@spritebook/core';

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
    minSpanPx: style.outline.minSpanPx,
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
    // The vote is taken over palette LABELS, so an empty palette makes every
    // opaque pixel label -1 and the sprite comes out blank — with `done` and
    // flickerPct 0, which reads as a perfect stability score rather than a
    // failure. StylePresetSchema refuses this combination, so reaching here
    // means a hand-built preset bypassed validation; refuse rather than write
    // 64x64 of nothing and call it success.
    if (palette.size === 0) {
      throw new Error(
        `style "${style.id}": temporal.clusterVote needs a palette, but quantize produced ` +
          'none - the vote is over palette labels, so every pixel would label -1 and the ' +
          'sprite would be blank. Set quantize on the preset.',
      );
    }
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

/**
 * True when any opaque pixel sits on the cell's border row or column — i.e. the
 * silhouette ran out of cell and was cut off by the frame edge.
 *
 * Nothing else detects this. `posedBounds` is often described as making "the
 * padding fit" hold, but camera.ts is explicit that the frustum never depends
 * on the bounds: bounds move the pivot anchor and the near/far bracket, and
 * nothing at all constrains the silhouette to the cell. So a roster whose
 * pixelsPerMeter x height exceeds cellPx ships decapitated in every frame of
 * every direction of every clip, and the only signal is looking at the pixels.
 */
function touchedEdges(rgba: Uint8Array, w: number, h: number): string[] {
  let top = 0, bottom = 0, left = 0, right = 0;
  for (let x = 0; x < w; x++) {
    if (rgba[x * 4 + 3] !== 0) top++;
    if (rgba[((h - 1) * w + x) * 4 + 3] !== 0) bottom++;
  }
  for (let y = 0; y < h; y++) {
    if (rgba[y * w * 4 + 3] !== 0) left++;
    if (rgba[(y * w + (w - 1)) * 4 + 3] !== 0) right++;
  }
  const hit: string[] = [];
  if (top) hit.push(`top:${top}px`);
  if (bottom) hit.push(`bottom:${bottom}px`);
  if (left) hit.push(`left:${left}px`);
  if (right) hit.push(`right:${right}px`);
  return hit;
}

/**
 * The QA flag a silhouette raises when it reaches the cell edge, naming which
 * edges and — this is the part that matters — the knob for THAT edge.
 *
 * The claim is deliberately what a styled cell can actually show: reaching the
 * border means the padding budget is spent there, so anything further out IS
 * lost; whether this particular frame lost pixels is not knowable from the cell
 * alone, and saying "cut off" flatly would overstate it.
 *
 * ## Why the bottom edge gets its own answer
 *
 * On a `feet-baseline` preset the camera pins world Y=0 onto the pivot row
 * (`cellPx.h - paddingPx`) BY CONSTRUCTION — camera.ts solves every direction
 * to hit that pixel, and the model bounds never enter the vertical solve. So
 * silhouette below the pivot row is geometry at or below the ground plane, and
 * the character is standing IN the floor rather than on it.
 *
 * Shrinking the camera does not fix that. It was nonetheless what this flag
 * used to say, and it said it on the P3 exit measurement: all 48 frames hit the
 * bottom edge because rigging had discarded the border's grounding and left the
 * body centred on the origin — half of it underground, 16 px below the pivot at
 * 32 px/m. Lowering `pixelsPerMeter` would have stopped the clipping by making
 * a half-buried character smaller, which is not the same thing as fixing it.
 *
 * The tilt is the honest caveat: at elevation, a ground point on the near edge
 * of the footprint projects a little below the anchor (`halfDepth·sin(el)·ppm`,
 * ~3 px for a 0.38 m-deep character at 30° and 32 px/m). That is what the
 * padding is FOR, so it does not reach the edge — and a bottom-edge hit means
 * the overshoot outgrew the padding, which the tilt alone does not do.
 */
function clippedFlag(
  refs: QAFlag['frameRefs'],
  edges: Set<string>,
  camera: CameraPreset,
): QAFlag | null {
  if (refs.length === 0) return null;
  const sides = [...edges].sort();
  const grounding = sides.includes('bottom') && camera.pivot === 'feet-baseline';
  const overflow = sides.some((e) => e !== 'bottom') || !grounding;

  const remedies: string[] = [];
  if (grounding) {
    const pivotRow = camera.cellPx.h - camera.paddingPx;
    remedies.push(
      `BOTTOM is not a framing problem on this preset: '${camera.id}' pins world Y=0 to row ` +
        `${pivotRow} of a ${camera.cellPx.h} px cell, so silhouette below it is geometry under ` +
        `the ground plane - the character is standing IN the floor. Lowering pixelsPerMeter ` +
        `only makes a half-buried character smaller, and no cell size fixes it. MEASURE before ` +
        `changing anything - \`deno run --allow-all tools/proofs/meshfloor.ts\` reports the ` +
        `skinned mesh's minimum world Y per clip, which is the ground truth this flag is a ` +
        `pixel-space shadow of. If the BIND POSE is below zero the mesh is ungrounded and ` +
        `\`spritebook rig --feet-ground\` re-runs with the body sat on Y=0. If only some CLIPS ` +
        `go below, look at which: a death or a slide compressing into the ground is the ` +
        `animation doing its job, and the remedy is more padding, not a correction that would ` +
        `make a body lying down hover.`,
    );
  }
  if (overflow) {
    remedies.push(
      `${sides.filter((e) => e !== 'bottom' || !grounding).join(', ')} means the character ` +
        `genuinely outgrew the cell: lower pixelsPerMeter or raise cellPx. If it is far too ` +
        `big, check the SCALE instead - a generated character keeps whatever scale its backend ` +
        `chose unless \`gen --height\` said otherwise, and gen warns when nobody did.`,
    );
  }

  return {
    code: 'silhouette-clipped',
    severity: 'warn',
    sourceStage: 'look',
    frameRefs: refs.slice(0, 8),
    message: `the silhouette reaches the cell edge on ${refs.length} frame` +
      `${refs.length === 1 ? '' : 's'} (${sides.join(', ')}). The padding budget is exhausted ` +
      `there, so anything further out is cut. ${remedies.join(' ')}`,
  };
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

/** One clip's Sx AOV source in a multi-clip bake. */
export interface ClipAovSource extends AovSource {
  clipId: string;
}

/**
 * Multi-clip styling (P3-T1): ONE palette pooled across every frame of EVERY
 * clip (the npr skill's per-character palette law — a per-clip palette would
 * flicker at clip boundaries), then the law-order pipeline per clip/direction,
 * writing `${outDir}/styled/<clipId>/dDD_fFFF.png`. Palette hysteresis resets
 * per clip x direction — chaining it across unrelated clips would couple clip
 * N's first frame to clip N-1's last. The flicker metric is measured on the
 * FIRST source's direction 0: the CALLER picks which clip that is (binding
 * order), and the reported number means that clip only. `frames` in the result
 * is the per-direction total across all clips. Single-clip styleFromAovs below
 * keeps its flat layout untouched.
 */
export async function styleClipsFromAovs(
  srcs: ClipAovSource[],
  camera: CameraPreset,
  style: StylePreset,
  outDir: string,
): Promise<StyleResult> {
  if (srcs.length === 0) throw new Error('styleClipsFromAovs: no sources');
  const s = style.temporal.superSample;
  const w1 = srcs[0].width / s, h1 = srcs[0].height / s;

  const perClip = new Map<string, AovImage[][]>();
  const allLit: Uint8Array[] = [];
  for (const src of srcs) {
    const aovs: AovImage[][] = [];
    for (let d = 0; d < src.directions; d++) {
      aovs[d] = [];
      for (let f = 0; f < src.frames; f++) {
        const aov = await readAov(src.framesDir, d, f);
        aovs[d][f] = aov;
        allLit.push(aov.lit);
      }
    }
    perClip.set(src.clipId, aovs);
  }

  const palette = buildPalette(style, allLit);
  const color = style.outline
    ? outlineColor(style, palette)
    : [0, 0, 0] as [number, number, number];
  const dither = ditherConfig(style);
  const styledDir = `${outDir}/styled`;
  const flickerFrames: Uint8Array[] = [];

  const clipped: QAFlag['frameRefs'] = [];
  const clippedEdges = new Set<string>();
  for (const src of srcs) {
    const aovs = perClip.get(src.clipId)!;
    const clipDir = `${styledDir}/${src.clipId}`;
    await Deno.mkdir(clipDir, { recursive: true });
    for (let d = 0; d < src.directions; d++) {
      let prev: Int32Array | null = null;
      for (let f = 0; f < src.frames; f++) {
        const { rgba, labels } = processFrame(aovs[d][f], style, palette, color, dither, prev);
        prev = labels;
        finishAlpha(rgba, style, w1, h1);
        const hitM = touchedEdges(rgba, w1, h1);
        if (hitM.length > 0) {
          clipped.push({ clipId: src.clipId, direction: d, frame: f });
          for (const e of hitM) clippedEdges.add(e.split(':')[0]);
        }
        if (src === srcs[0] && d === 0) flickerFrames.push(rgba.slice());
        await Deno.writeFile(
          `${clipDir}/${tag(d, f)}.png`,
          encodePng({ width: w1, height: h1, data: rgba }),
        );
      }
    }
  }

  return {
    stylePresetId: style.id,
    cameraPresetId: camera.id,
    directions: srcs[0].directions,
    // honest multi-clip accounting: total frames per direction, not clip 0's
    frames: srcs.reduce((n, src) => n + src.frames, 0),
    cellPx: { w: w1, h: h1 },
    superSample: s,
    paletteHex: paletteToHex(palette),
    flickerPct: flickerPct(flickerFrames, w1, h1),
    flags: [
      ...qaFlags(style, camera),
      ...[clippedFlag(clipped, clippedEdges, camera)].filter((f) => f !== null),
    ],
    styledDir,
  };
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
  const clipped: QAFlag['frameRefs'] = [];
  const clippedEdges = new Set<string>();
  for (let d = 0; d < src.directions; d++) {
    let prev: Int32Array | null = null;
    for (let f = 0; f < src.frames; f++) {
      const { rgba, labels } = processFrame(aovs[d][f], style, palette, color, dither, prev);
      prev = labels;
      finishAlpha(rgba, style, w1, h1);
      const hitS = touchedEdges(rgba, w1, h1);
      if (hitS.length > 0) {
        clipped.push({ clipId: 'idle', direction: d, frame: f });
        for (const e of hitS) clippedEdges.add(e.split(':')[0]);
      }
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
    flags: [
      ...qaFlags(style, camera),
      ...[clippedFlag(clipped, clippedEdges, camera)].filter((f) => f !== null),
    ],
    styledDir,
  };
}
