/**
 * Frozen internal contracts for @spritebook/pack + @spritebook/export (P2-T3).
 * The packer turns styled frames + 1x AOV planes into atlas pages behind the
 * PARALLEL-LAYOUT LAW; exporters are PURE PROJECTIONS of the BakeManifest.
 * Everything here is plain data — no GPU, no pixels across the D-004 seam.
 *
 * THE PARALLEL-LAYOUT LAW (bake.ts / atlas.ts): the layout is computed ONCE,
 * from the lit cells, and replayed VERBATIM onto every AOV page. Rect-identity
 * across passes is therefore true by construction — and still asserted exactly
 * in tests, because laws get proofs, not trust.
 *
 * BYTE-STABILITY DOCTRINE (exporters): two bakes of identical inputs produce
 * BakeManifests differing only in VOLATILE fields. Exporters must never project
 * a volatile field, so export(unchanged bake) is byte-identical. The volatile
 * fields are exactly: `createdAt`, `metrics.wallTimeS`. Everything else in the
 * manifest is a deterministic function of the recipe (bakeId is a prefix of the
 * input hash; flickerPct/cacheHitPct are deterministic given the recipe and
 * cache state — cacheHitPct is still treated as volatile for projection since
 * it varies with cache warmth: exporters must not project it either).
 *
 * FRAME CACHE KEY RECIPE (cache.ts): the style stage is CLIP-ATOMIC (palette
 * pools over all frames; hysteresis chains within a direction), so every frame
 * key embeds the FULL recipe:
 *   frameKey = sha256Hex(canonicalJson({
 *     bake: computeCacheKey(CacheKeyInputs),   // 64-hex bake-level key
 *     clipId, direction, frame,
 *   }))
 * A style/look change flips the bake key -> every frame misses (exactly what
 * the look stage predicts, because the palette depends on every frame). A
 * rename cannot reach the key at all (core's displayName guarantee).
 *
 * BAKE DIR LAYOUT (`<outRoot>/bake-<bakeId>/`):
 *   manifest.json          canonical BakeManifest
 *   atlas_<pass>_<i>.png   atlas pages (lit/albedo/normal rgba8; depth/mask gray16)
 *   style-result.json      the style stage's artifact (palette lives here —
 *                          BakeManifest has no palette field by schema)
 *   contact-idle.gif       review-only contact sheet (gifenc)
 */
import type { BakeManifest, RenderPass } from '@spritebook/schema';

// ---------------------------------------------------------------------------
// Packing (maxrects.ts + atlas.ts) — Agent A
// ---------------------------------------------------------------------------
export interface FrameId {
  clipId: string;
  direction: number;
  frame: number;
}

/** Stable string form of a FrameId (map keys, file names): `idle/d00/f003`. */
export function frameIdKey(id: FrameId): string {
  const d = String(id.direction).padStart(2, '0');
  const f = String(id.frame).padStart(3, '0');
  return `${id.clipId}/d${d}/f${f}`;
}

export interface PlacedRect {
  id: FrameId;
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PackLayout {
  /** number of pages (all passes share it — the law) */
  pageCount: number;
  /** square page edge in px (power of two) */
  pageSizePx: number;
  /** one rect per cell, in the DETERMINISTIC input order (sorted frameIdKey) */
  rects: PlacedRect[];
}

export interface PackOptions {
  /** hard ceiling on the square page edge (px) */
  maxPageSizePx?: number; // default 2048
  /** transparent gutter between rects, px (cells self-pad; this guards bilinear) */
  gapPx?: number; // default 2
}

/** Per-pass pixel format of the atlas pages. */
export const PAGE_KIND: Record<RenderPass, 'rgba8' | 'gray16'> = {
  lit: 'rgba8',
  albedo: 'rgba8',
  normal: 'rgba8',
  depth: 'gray16',
  mask: 'gray16',
};

/** A decoded 1x cell plane for compositing (exactly one of rgba/gray16 set). */
export interface CellPlane {
  w: number;
  h: number;
  rgba?: Uint8Array; // w*h*4
  gray16?: Uint16Array; // w*h
}

export function atlasPageName(pass: RenderPass, pageIndex: number): string {
  return `atlas_${pass}_${pageIndex}.png`;
}

// ---------------------------------------------------------------------------
// 1x AOV cells (aov1x.ts) — Agent A. Sx -> 1x per AOV:
//   albedo  rgba8   AREA-AVERAGE (it is a color)
//   normal  rgba8   CENTER-TAP  (data AOV — averaging invents directions)
//   depth   gray16  CENTER-TAP  (data AOV)
//   mask    gray16  CENTER-TAP  (object ids must never blend)
// Center-tap = the (s/2, s/2) subpixel of each s x s block (deterministic).
// ---------------------------------------------------------------------------
export interface Aov1xCells {
  albedo: CellPlane;
  normal: CellPlane;
  depth: CellPlane;
  mask: CellPlane;
}

// ---------------------------------------------------------------------------
// Exporters (packages/export) — Agents B & C + me. Pure projections:
// read manifest + pages under bakeDir, write files under outDir, return the
// written paths (sorted). NEVER read the clock, NEVER project volatile fields.
// ---------------------------------------------------------------------------
export interface ExportOptions {
  /** frames-per-second used for durations until ClipBinding lands (anim pkg) */
  fps: number;
}

export const DEFAULT_FPS = 8;

export type Exporter = (
  manifest: BakeManifest,
  bakeDir: string,
  outDir: string,
  opts: ExportOptions,
) => Promise<string[]>;

/** Manifest fields exporters must never project (byte-stability doctrine). */
export const VOLATILE_FIELDS = ['createdAt', 'metrics.wallTimeS', 'metrics.cacheHitPct'] as const;

// RENDERER_VERSION moved home to @spritebook/render (P2-T4): the render package
// owns its version, and cache keys carry renderSignature() — version + adapter
// hash (D-023) — so an adapter change is an honest full cache miss.
