/**
 * Frozen internal contracts for @spritebook/style (P2-T2). The NPR stack is pure
 * CPU image-processing over the render module's AOV PNGs — it consumes the D-004
 * render seam (files in) and writes styled sprites (files out), touching no GPU
 * itself. Because the stage math is deterministic on fixed inputs, the whole
 * package is testable from COMMITTED AOV fixtures on any machine.
 *
 * THE PIPELINE ORDER IS LAW (npr-sprite-stylization skill) — most flicker bugs
 * are ordering bugs. The stages, in order, and who owns each:
 *
 *   1. render supersampled at Sx (linear) via the render seam        [render pkg]
 *   2. extract outlines at Sx from depth + normal discontinuities    [outline.ts / B]
 *   3. composite outline into lit; operate in display (sRGB) space    [pipeline.ts / me]
 *   4. downsample Sx -> 1x: cluster-vote (quantized) / area-avg       [downsample.ts / B]
 *   5. quantize to the palette (OKLab nearest) with hysteresis        [palette.ts / A]
 *   +  ordered dither, 1-bit alpha + edge bleed                       [dither.ts, alpha.ts / me]
 *
 * The adaptive palette is built ONCE per character across ALL frames (skill:
 * non-negotiable; per-frame palettes guarantee flicker). Cluster-vote operates
 * on palette LABELS (quantize Sx -> vote per 1x block), never on averaged colors.
 */
import type { CameraPreset, QAFlag, StylePreset } from '@spritebook/schema';

// ---------------------------------------------------------------------------
// AOV planes for one direction/frame, decoded from the render module's PNGs.
// lit/albedo/normal are 8-bit RGBA; depth/mask are 16-bit single-channel.
// lit is sRGB display-ready (the render module encodes it); albedo is linear;
// normal is encoded n*0.5+0.5; depth is normalized linear view depth in
// [0,65535]; mask is coverage (1 = drawn, 0 = empty).
// ---------------------------------------------------------------------------
export interface AovImage {
  width: number;
  height: number;
  lit: Uint8Array; // rgba8, w*h*4
  albedo: Uint8Array; // rgba8
  normal: Uint8Array; // rgba8
  depth: Uint16Array; // gray16, w*h
  mask: Uint16Array; // gray16, w*h
}

/** Where the render module wrote a job's Sx AOV pages, + the grid it used. */
export interface AovSource {
  framesDir: string;
  directions: number;
  frames: number;
  /** Sx render resolution (== 1x cellPx * superSample) */
  width: number;
  height: number;
}

/** Render module's per-AOV file name: `d{DD}_f{FFF}_{pass}.png`. */
export function aovFileName(direction: number, frame: number, pass: string): string {
  const d = String(direction).padStart(2, '0');
  const f = String(frame).padStart(3, '0');
  return `d${d}_f${f}_${pass}.png`;
}

// ---------------------------------------------------------------------------
// Perceptual color (oklab.ts + palette.ts) — Agent A
// ---------------------------------------------------------------------------
/** An OKLab triple (L, a, b). */
export type Lab = readonly [number, number, number];

export interface Palette {
  /** N colors as sRGB bytes, 3 per color (r,g,b); deterministic order */
  srgb: Uint8Array;
  /** N OKLab triples, precomputed for nearest-match (parallel to srgb) */
  lab: Float32Array;
  size: number;
}

// ---------------------------------------------------------------------------
// Outline (outline.ts) — Agent B
// ---------------------------------------------------------------------------
export interface OutlineParams {
  /** supersample factor S: a 1x stroke of widthPx is widthPx*S at render res */
  superSample: number;
  /** 1x stroke width (StylePreset.outline.widthPx); may be fractional */
  widthPx: number;
  /** 1x span below which the SILHOUETTE stroke is dropped (0/absent = never) */
  minSpanPx?: number;
  /** dot(n_a, n_b) < this -> interior crease */
  normalThreshold: number;
  /** |depth_a - depth_b| > this * depth -> crease (threshold SCALED by depth) */
  depthThresholdScaled: number;
}

// ---------------------------------------------------------------------------
// The seam (mod.ts) + result. StyleJobSpec is plain data in; files + a
// StyleResult (serialized to JSON) out. QAFlag/CameraPreset/StylePreset come
// from @spritebook/schema so the packer (P2-T3) folds them into the BakeManifest.
// ---------------------------------------------------------------------------
export interface StyleJobSpec {
  jobId: string;
  /** canonical glb (same input the render border consumes) */
  modelPath: string;
  /** 1x output framing; the style stage renders at cellPx*superSample internally */
  camera: CameraPreset;
  style: StylePreset;
  frames: number;
  outDir: string;
}

export interface StyleResult {
  stylePresetId: string;
  cameraPresetId: string;
  directions: number;
  frames: number;
  cellPx: { w: number; h: number };
  superSample: number;
  /** the character's adaptive palette as #rrggbb, for palette.json + membership */
  paletteHex: string[];
  /** mean % changed px frame-to-frame on the idle loop (BakeMetrics.flickerPct) */
  flickerPct: number;
  flags: QAFlag[];
  styledDir: string;
}
