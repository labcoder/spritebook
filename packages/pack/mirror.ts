/**
 * Mirrored directions at bake time (D-008), the pack half.
 *
 * `packages/schema/roster.ts` owns the RULE — which directions may be produced
 * by flipping which, and why it is opt-in. Nothing here re-derives it: the plan
 * below is `renderedDirections`/`mirrorSource` turned into the two lookups the
 * bake loop needs. This module owns only the PIXEL side: what "the horizontal
 * flip of a cell" means for each of the five passes.
 *
 * ## Why a flip is not just a flip
 *
 * A character at yaw θ and at yaw −θ are mirror images through the world plane
 * x = 0. Under that mirror the screen basis maps s -> −s, u -> u, f -> f
 * (the cross product flips sign because the mirror's determinant is −1), so the
 * image flips in x, and depth and the vertical axis are untouched. That makes
 * lit, albedo, depth and mask pure column reversals — they carry colors, a
 * scalar distance, and a coverage flag, none of which know about direction.
 *
 * `normal` does. The AOV stores the WORLD-space normal encoded as n*0.5+0.5
 * (render/shaders.wgsl), and the mirror maps a normal n to (−n.x, n.y, n.z). So
 * the mirrored cell is the column reversal AND the negation of the encoded X
 * channel, which in byte space is exactly `255 - r`. A mirrored normal map that
 * only moves pixels lights the mirrored half of a roster from the wrong side —
 * a bug that never shows up in the sprite preview and always shows up in the
 * engine. (The one unavoidable wart: n.x = 0 encodes to byte 128 and negates to
 * 127, a half-LSB bias inherent to storing a zero-centred value in 8 bits.)
 *
 * Temporal note (npr-sprite-stylization): flipping shifts the ordered-dither
 * phase of a mirrored direction relative to its source. That is harmless for
 * flicker because the flip is IDENTICAL for every frame of that direction, so
 * the dither stays position-locked along the axis that matters — time.
 */
import { decode as decodePng } from 'fast-png';
import type { RenderPass } from '@spritebook/schema';
import { mirrorSource, renderedDirections } from '@spritebook/schema';
import { type CellPlane, PAGE_KIND } from './contracts.ts';
import { encodePagePng } from './atlas.ts';

export interface MirrorPlan {
  /** directions that must be rendered AND styled, ascending */
  rendered: number[];
  /** mirrored direction -> the rendered direction its pixels are flipped from */
  mirroredFrom: Map<number, number>;
}

/**
 * Turn the frozen rule into the bake's two lookups. `mirroring: false` yields
 * every direction rendered and an empty mirror map — the D-008 default, and the
 * only shape the P2-era bake ever saw.
 */
export function mirrorPlan(directions: number, mirroring: boolean): MirrorPlan {
  const rendered = renderedDirections(directions, mirroring);
  const mirroredFrom = new Map<number, number>();
  for (let d = 0; d < directions; d++) {
    if (!mirroring) continue;
    const source = mirrorSource(d, directions);
    if (source !== null) mirroredFrom.set(d, source);
  }
  return { rendered, mirroredFrom };
}

/**
 * The style stage addresses directions POSITIONALLY (`d00_f000.png` is the
 * first direction it was handed), while the packer addresses them by their true
 * index. The two agree only while the rendered set is the prefix [0..M-1] —
 * which `renderedDirections` always returns, since a direction and its mirror
 * source pair up around the front. This is the guard that says so out loud
 * rather than letting a future rule change silently bake direction 5's pixels
 * into direction 2's cell.
 */
export function assertRenderedPrefix(plan: MirrorPlan): void {
  for (const [i, d] of plan.rendered.entries()) {
    if (d !== i) {
      throw new Error(
        `mirroring: rendered directions must be the prefix [0..n-1] for the style stage's ` +
          `positional naming, but position ${i} is direction ${d} - the mirror rule changed ` +
          `shape and bake.ts must map style positions to directions explicitly`,
      );
    }
  }
}

/** Horizontal flip of one plane. `normal` also negates its encoded X channel. */
export function flipPlaneH(plane: CellPlane, pass: RenderPass): CellPlane {
  const { w, h } = plane;
  if (PAGE_KIND[pass] === 'rgba8') {
    const src = plane.rgba;
    if (!src || src.length !== w * h * 4) {
      throw new RangeError(`flipPlaneH: ${pass} cell must carry w*h*4 rgba bytes`);
    }
    const out = new Uint8Array(w * h * 4);
    // world-space normals mirror through x = 0, so the encoded X byte inverts
    const negateX = pass === 'normal';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const from = (y * w + x) * 4;
        const to = (y * w + (w - 1 - x)) * 4;
        out[to] = negateX ? 255 - src[from] : src[from];
        out[to + 1] = src[from + 1];
        out[to + 2] = src[from + 2];
        out[to + 3] = src[from + 3];
      }
    }
    return { w, h, rgba: out };
  }
  const src = plane.gray16;
  if (!src || src.length !== w * h) {
    throw new RangeError(`flipPlaneH: ${pass} cell must carry w*h gray16 values`);
  }
  const out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + (w - 1 - x)] = src[y * w + x];
  }
  return { w, h, gray16: out };
}

/**
 * The same flip over the encoded cell bytes the bake actually holds. Decoding
 * and re-encoding costs a little, and buys the guarantee that a mirrored cell is
 * a flip of EXACTLY the bytes its source contributed to the atlas — not of some
 * parallel copy that could drift.
 */
export function flipCellPng(bytes: Uint8Array, pass: RenderPass): Uint8Array {
  const kind = PAGE_KIND[pass];
  const img = decodePng(bytes);
  const plane: CellPlane = kind === 'rgba8'
    ? { w: img.width, h: img.height, rgba: img.data as Uint8Array }
    : { w: img.width, h: img.height, gray16: img.data as Uint16Array };
  return encodePagePng(flipPlaneH(plane, pass), kind);
}
