/**
 * Deterministic atlas layout over npm `maxrects-packer@2.7.3` (P2-T3). One call computes
 * THE layout; atlas.ts replays it verbatim onto every AOV page (parallel-layout law).
 *
 * DETERMINISM VERDICT (P2-T3 de-risk): the packer is deterministic under our pinned
 * options. Evidence, from reading lib/ + dist/ of the installed 2.7.3:
 *   - no Math.random, no Date/clock, no environment reads; fully synchronous;
 *   - every iteration walks plain arrays in index order (no object-key or Map order);
 *   - the ONLY implementation-approximated float path is the `smart` bin growth
 *     (`Math.pow(2, Math.ceil(Math.log(w) * Math.LOG2E))` in updateBinSize). We pin
 *     `smart: false`, which early-returns before that code, so every arithmetic op on
 *     our path is integer add/sub/min/max — exact in IEEE doubles on any engine;
 *   - `addArray()` sorts by size internally; we bypass it and call `add()` per cell in
 *     canonical frameIdKey order, so placement order never depends on Array.sort at all;
 *   - empirical: identical layouts across fresh packer instances and across separate
 *     processes (spiked before landing; re-proven by the pack-twice canary test).
 *
 * PINNED PACKER OPTIONS — a change here changes every layout, so treat as a format bump:
 *   { smart: false, pot: false, square: false, allowRotation: false, tag: false,
 *     border: 0 }, padding = gapPx, fixed square bins of pageSizePx.
 *   allowRotation MUST stay false: AOV pages replay rects verbatim and sprite cells must
 *   never rotate. pot/square/smart stay false because PAGE SIZING IS OURS (below), in
 *   integer math, not the packer's float pot path.
 *
 * PAGE SIZING: try the smallest power-of-two square >= the largest cell edge, pack with a
 * fixed bin of that size, and double until everything fits ON ONE PAGE (capped at the
 * largest power of two <= maxPageSizePx). If even the cap cannot hold them on one page,
 * the cap-size pack stands and overflows to more pages — every page the same size, which
 * is what the parallel-layout law and PackLayout's single pageSizePx require.
 *
 * The packer's `padding` pads the right/bottom of each placed rect, which yields >= gapPx
 * of clear gutter between any two rects while still allowing cells to sit flush against
 * page edges (cells self-pad; the gap only guards bilinear taps between neighbors).
 */
import { MaxRectsPacker } from 'maxrects-packer';
import { type FrameId, frameIdKey, type PackLayout, type PlacedRect } from './contracts.ts';
import type { PackOptions } from './contracts.ts';

/** One cell to place: a frame id plus its 1x pixel size. */
export interface PackCell {
  id: FrameId;
  w: number;
  h: number;
}

export const DEFAULT_MAX_PAGE_SIZE_PX = 2048;
export const DEFAULT_GAP_PX = 2;

/** The frozen packer options (see file header). Exported so tests can pin them too. */
export const PINNED_PACKER_OPTIONS = {
  smart: false,
  pot: false,
  square: false,
  allowRotation: false,
  tag: false,
  border: 0,
} as const;

/** Smallest power of two >= v (v >= 1), integer math only. */
function smallestPotAtLeast(v: number): number {
  let p = 1;
  while (p < v) p *= 2;
  return p;
}

/** Largest power of two <= v (v >= 1), integer math only. */
function largestPotAtMost(v: number): number {
  let p = 1;
  while (p * 2 <= v) p *= 2;
  return p;
}

interface CanonicalCell {
  key: string;
  id: FrameId;
  w: number;
  h: number;
}

/** One fixed-page-size packing attempt at `pageSizePx`; always places every cell. */
function tryPack(cells: CanonicalCell[], pageSizePx: number, gapPx: number): PackLayout {
  const packer = new MaxRectsPacker(pageSizePx, pageSizePx, gapPx, PINNED_PACKER_OPTIONS);
  for (const cell of cells) packer.add(cell.w, cell.h, { key: cell.key });

  const placedByKey = new Map<string, { pageIndex: number; x: number; y: number }>();
  packer.bins.forEach((bin, pageIndex) => {
    for (const rect of bin.rects) {
      const key = (rect.data as { key: string }).key;
      if (rect.rot || rect.oversized) {
        throw new Error(
          `packLayout: packer rotated or oversized cell ${key} (pinned options broken)`,
        );
      }
      if (
        rect.x < 0 || rect.y < 0 || rect.x + rect.width > pageSizePx ||
        rect.y + rect.height > pageSizePx
      ) {
        throw new Error(
          `packLayout: cell ${key} placed out of bounds at ${rect.x},${rect.y} on a ${pageSizePx}px page`,
        );
      }
      placedByKey.set(key, { pageIndex, x: rect.x, y: rect.y });
    }
  });

  // Return rects in the canonical sorted-by-frameIdKey order, not bin order.
  const rects: PlacedRect[] = cells.map((cell) => {
    const placed = placedByKey.get(cell.key);
    if (!placed) throw new Error(`packLayout: packer dropped cell ${cell.key}`);
    return {
      id: { clipId: cell.id.clipId, direction: cell.id.direction, frame: cell.id.frame },
      pageIndex: placed.pageIndex,
      x: placed.x,
      y: placed.y,
      w: cell.w,
      h: cell.h,
    };
  });
  return { pageCount: packer.bins.length, pageSizePx, rects };
}

/**
 * Compute the deterministic atlas layout for `cells`. Same input -> identical layout,
 * across runs and machines (see file header). Cells may be any per-cell sizes; T3 happens
 * to feed uniform ones. Throws RangeError on invalid sizes/options and when a single cell
 * cannot fit any page <= maxPageSizePx; throws Error on duplicate frame ids.
 */
export function packLayout(cells: PackCell[], opts: PackOptions = {}): PackLayout {
  const maxPageSizePx = opts.maxPageSizePx ?? DEFAULT_MAX_PAGE_SIZE_PX;
  const gapPx = opts.gapPx ?? DEFAULT_GAP_PX;
  if (!Number.isInteger(maxPageSizePx) || maxPageSizePx < 1) {
    throw new RangeError(`maxPageSizePx must be a positive integer, got ${maxPageSizePx}`);
  }
  if (!Number.isInteger(gapPx) || gapPx < 0) {
    throw new RangeError(`gapPx must be a non-negative integer, got ${gapPx}`);
  }
  if (cells.length === 0) return { pageCount: 0, pageSizePx: 0, rects: [] };

  const canonical: CanonicalCell[] = cells
    .map((cell) => ({ key: frameIdKey(cell.id), id: cell.id, w: cell.w, h: cell.h }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const maxPot = largestPotAtMost(maxPageSizePx);
  let largestEdge = 1;
  for (let i = 0; i < canonical.length; i++) {
    const { key, w, h } = canonical[i];
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
      throw new RangeError(`cell ${key} has invalid size ${w}x${h} (positive integers required)`);
    }
    if (i > 0 && canonical[i - 1].key === key) {
      throw new Error(`packLayout: duplicate frame id ${key}`);
    }
    const edge = Math.max(w, h);
    if (edge > maxPot) {
      throw new RangeError(
        `cell ${key} (${w}x${h}) exceeds the largest page (${maxPot}px, maxPageSizePx ${maxPageSizePx})`,
      );
    }
    if (edge > largestEdge) largestEdge = edge;
  }

  let layout = tryPack(canonical, smallestPotAtLeast(largestEdge), gapPx);
  while (layout.pageCount > 1 && layout.pageSizePx < maxPot) {
    layout = tryPack(canonical, layout.pageSizePx * 2, gapPx);
  }
  return layout;
}

/** Keep each uniform clip/direction together when it fits a page; retain honest overflow otherwise. */
export function packAnimationLayout(cells: PackCell[], opts: PackOptions = {}): PackLayout {
  const original = packLayout(cells, opts);
  if (original.pageCount <= 1) return original;
  const { w, h } = cells[0];
  if (cells.some((cell) => cell.w !== w || cell.h !== h)) return original;
  const gap = opts.gapPx ?? DEFAULT_GAP_PX;
  const cap = original.pageSizePx;
  const groups = new Map<string, PackCell[]>();
  for (const cell of cells) {
    const key = JSON.stringify([cell.id.clipId, cell.id.direction]);
    const group = groups.get(key) ?? [];
    group.push(cell);
    groups.set(key, group);
  }
  const blocks: (PackCell & { columns: number; cells: PackCell[] })[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.id.frame - b.id.frame);
    let best: { columns: number; w: number; h: number } | undefined;
    for (
      let columns = 1;
      columns <= Math.min(group.length, Math.floor((cap + gap) / (w + gap)));
      columns++
    ) {
      const width = columns * (w + gap) - gap;
      const height = Math.ceil(group.length / columns) * (h + gap) - gap;
      if (height > cap) continue;
      if (
        !best || width * height < best.w * best.h ||
        width * height === best.w * best.h && Math.max(width, height) < Math.max(best.w, best.h)
      ) {
        best = { columns, w: width, h: height };
      }
    }
    if (!best) {
      // Only this sequence must span pages. Falling back for the whole bake
      // would also split smaller animations that can stay intact.
      blocks.push(...group.map((cell) => ({ ...cell, columns: 1, cells: [cell] })));
      continue;
    }
    blocks.push({ id: group[0].id, ...best, cells: group });
  }
  const layout = packLayout(blocks, opts);
  const byKey = new Map(blocks.map((block) => [frameIdKey(block.id), block]));
  return {
    ...layout,
    rects: layout.rects.flatMap((rect) => {
      const block = byKey.get(frameIdKey(rect.id))!;
      return block.cells.map((cell, index) => ({
        id: cell.id,
        pageIndex: rect.pageIndex,
        x: rect.x + index % block.columns * (w + gap),
        y: rect.y + Math.floor(index / block.columns) * (h + gap),
        w,
        h,
      }));
    }).sort((a, b) => frameIdKey(a.id) < frameIdKey(b.id) ? -1 : 1),
  };
}
