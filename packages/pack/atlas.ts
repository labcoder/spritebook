/**
 * Atlas page compositor (P2-T3) — THE PARALLEL-LAYOUT LAW made executable. The bake
 * computes ONE PackLayout (maxrects.ts) and calls composePage once per pass with that
 * same layout, so AOV pages are rect-identical to the lit page by construction.
 * assertRectIdentity is the belt-and-braces proof: the bake and the tests still assert
 * exact rect equality across the layouts used, because laws get proofs, not trust.
 *
 * PURE CPU: zero-filled page planes (transparent / zero), row-by-row typed-array copies,
 * fixed iteration order, no clock, no randomness. PNG encoding is fast-png (pure JS),
 * rgba8 -> 8-bit RGBA, gray16 -> 16-bit single-channel, matching PAGE_KIND.
 */
import { encode as encodePng } from 'fast-png';
import { type CellPlane, frameIdKey, type PackLayout } from './contracts.ts';

/**
 * Composite every rect of `layout` that lives on `pageIndex` into a fresh page plane.
 * `cells` is keyed by `frameIdKey(rect.id)`; each cell must carry the plane matching
 * `kind` and the exact w/h of its rect. Uncovered pixels stay zero (transparent).
 */
export function composePage(
  layout: PackLayout,
  pageIndex: number,
  cells: Map<string, CellPlane>,
  kind: 'rgba8' | 'gray16',
): CellPlane {
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= layout.pageCount) {
    throw new RangeError(
      `composePage: pageIndex ${pageIndex} out of range (layout has ${layout.pageCount} pages)`,
    );
  }
  const size = layout.pageSizePx;
  const rgba = kind === 'rgba8' ? new Uint8Array(size * size * 4) : undefined;
  const gray16 = kind === 'gray16' ? new Uint16Array(size * size) : undefined;

  for (const rect of layout.rects) {
    if (rect.pageIndex !== pageIndex) continue;
    const key = frameIdKey(rect.id);
    const cell = cells.get(key);
    if (!cell) throw new Error(`composePage: missing cell plane for ${key}`);
    if (cell.w !== rect.w || cell.h !== rect.h) {
      throw new Error(
        `composePage: cell ${key} is ${cell.w}x${cell.h} but its rect is ${rect.w}x${rect.h}`,
      );
    }
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > size || rect.y + rect.h > size) {
      throw new Error(
        `composePage: rect ${key} at ${rect.x},${rect.y} (${rect.w}x${rect.h}) overflows the ${size}px page`,
      );
    }
    if (kind === 'rgba8') {
      const src = cell.rgba;
      if (!src || src.length !== cell.w * cell.h * 4) {
        throw new Error(`composePage: cell ${key} has no valid rgba plane (page kind rgba8)`);
      }
      for (let y = 0; y < rect.h; y++) {
        const row = src.subarray(y * rect.w * 4, (y + 1) * rect.w * 4);
        rgba!.set(row, ((rect.y + y) * size + rect.x) * 4);
      }
    } else {
      const src = cell.gray16;
      if (!src || src.length !== cell.w * cell.h) {
        throw new Error(`composePage: cell ${key} has no valid gray16 plane (page kind gray16)`);
      }
      for (let y = 0; y < rect.h; y++) {
        const row = src.subarray(y * rect.w, (y + 1) * rect.w);
        gray16!.set(row, (rect.y + y) * size + rect.x);
      }
    }
  }
  return kind === 'rgba8'
    ? { w: size, h: size, rgba: rgba! }
    : { w: size, h: size, gray16: gray16! };
}

/**
 * Assert that every layout is rect-identical to the first: same pageCount, pageSizePx,
 * and every rect equal field-by-field (id, page, x, y, w, h) at the same index. The bake
 * replays ONE layout object across all five passes, so this should be true by
 * construction — it throws naming the first divergence if that law is ever broken.
 */
export function assertRectIdentity(layouts: PackLayout[]): void {
  if (layouts.length < 2) return;
  const ref = layouts[0];
  for (let i = 1; i < layouts.length; i++) {
    const layout = layouts[i];
    if (layout.pageCount !== ref.pageCount) {
      throw new Error(
        `assertRectIdentity: layout ${i} pageCount ${layout.pageCount} !== ${ref.pageCount} (layout 0)`,
      );
    }
    if (layout.pageSizePx !== ref.pageSizePx) {
      throw new Error(
        `assertRectIdentity: layout ${i} pageSizePx ${layout.pageSizePx} !== ${ref.pageSizePx} (layout 0)`,
      );
    }
    if (layout.rects.length !== ref.rects.length) {
      throw new Error(
        `assertRectIdentity: layout ${i} has ${layout.rects.length} rects, layout 0 has ${ref.rects.length}`,
      );
    }
    for (let j = 0; j < ref.rects.length; j++) {
      const a = ref.rects[j];
      const b = layout.rects[j];
      const fields = [
        ['clipId', a.id.clipId, b.id.clipId],
        ['direction', a.id.direction, b.id.direction],
        ['frame', a.id.frame, b.id.frame],
        ['pageIndex', a.pageIndex, b.pageIndex],
        ['x', a.x, b.x],
        ['y', a.y, b.y],
        ['w', a.w, b.w],
        ['h', a.h, b.h],
      ] as const;
      for (const [field, refValue, value] of fields) {
        if (value !== refValue) {
          throw new Error(
            `assertRectIdentity: layout ${i} diverges at rect ${j} (${frameIdKey(a.id)}): ` +
              `${field} ${value} !== ${refValue} (layout 0)`,
          );
        }
      }
    }
  }
}

/**
 * Encode a composed page to PNG bytes: rgba8 -> 8-bit RGBA, gray16 -> 16-bit
 * single-channel gray (fast-png writes network-order 16-bit per the PNG spec, and
 * decodes it back to Uint16Array losslessly).
 */
export function encodePagePng(plane: CellPlane, kind: 'rgba8' | 'gray16'): Uint8Array {
  if (kind === 'rgba8') {
    if (!plane.rgba || plane.rgba.length !== plane.w * plane.h * 4) {
      throw new RangeError(`encodePagePng: rgba8 plane must carry w*h*4 rgba bytes`);
    }
    return encodePng({ width: plane.w, height: plane.h, data: plane.rgba });
  }
  if (!plane.gray16 || plane.gray16.length !== plane.w * plane.h) {
    throw new RangeError(`encodePagePng: gray16 plane must carry w*h gray16 values`);
  }
  return encodePng({ width: plane.w, height: plane.h, data: plane.gray16, channels: 1, depth: 16 });
}
