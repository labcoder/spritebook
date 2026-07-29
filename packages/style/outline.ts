/**
 * Outline stroke extraction at supersample (render) resolution for the NPR stack
 * (P2-T2, npr-sprite-stylization skill). PURE CPU over decoded AOV planes — no GPU,
 * no PNGs, no files. This stage answers only WHERE the outline strokes sit (a 0/1 byte
 * mask at Sx resolution); the integrator colors them later from a darkened palette
 * entry, so black is never baked in here.
 *
 * Two edge sources, straight from the skill:
 *   - Exterior silhouette: an opaque object-id texel (mask != 0) touching an empty one
 *     (mask == 0). Only the OPAQUE side is marked, so a stroke never lands on a
 *     background texel — the mask is the object-id/alpha edge.
 *   - Interior crease: between two OPAQUE texels whose surface normals diverge
 *     (dot(n_a, n_b) < normalThreshold) OR whose linear depth steps
 *     (|d_a - d_b| > depthThresholdScaled * d_a). The depth threshold is SCALED by the
 *     texel's own normalized depth — a constant threshold draws phantom lines up close
 *     and misses them far away (skill).
 *
 * Stroke width follows the supersample factor: a 1x stroke of widthPx is widthPx*S at
 * render resolution, so stroke = max(1, round(widthPx * superSample)). The detected 1px
 * edges are thickened to that width by dilation INTO OPAQUE TEXELS ONLY (see
 * extractOutline). Everything here is deterministic: fixed iteration order, buffers
 * allocated once, no Math.random, no wall clock.
 */
import type { AovImage, OutlineParams } from './contracts.ts';

const INV_255 = 1 / 255;
const INV_65535 = 1 / 65535;

/** 4-neighbour offsets — the edge test is per texel vs its 4 neighbours (skill). */
const N4_DX = [1, -1, 0, 0] as const;
const N4_DY = [0, 0, 1, -1] as const;

/** 8-neighbour offsets — the stroke dilation uses a 3x3 (Chebyshev) structuring element. */
const N8_DX = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
const N8_DY = [-1, -1, -1, 0, 0, 1, 1, 1] as const;

/** Decoded, unit-length surface normals as three parallel planes (w*h each). */
interface DecodedNormals {
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
}

/**
 * Decode the normal AOV to unit vectors: n = (byte/255)*2 - 1 per channel (alpha
 * skipped), then normalized so dot(n_a, n_b) is a true cosine against normalThreshold.
 * An empty texel is byte (0,0,0,0), which decodes to (-1,-1,-1) and normalizes
 * to (-0.577, -0.577, -0.577) — NOT zero, as this note used to claim. That is
 * harmless only because creases are evaluated between OPAQUE texels, whose
 * normals are well-formed, so an empty texel is never a side of a comparison.
 */
function decodeNormals(aov: AovImage): DecodedNormals {
  const n = aov.width * aov.height;
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const nz = new Float32Array(n);
  const src = aov.normal;
  for (let i = 0; i < n; i++) {
    const b = i * 4;
    const x = src[b] * INV_255 * 2 - 1;
    const y = src[b + 1] * INV_255 * 2 - 1;
    const z = src[b + 2] * INV_255 * 2 - 1;
    const len = Math.hypot(x, y, z);
    if (len > 1e-6) {
      const inv = 1 / len;
      nx[i] = x * inv;
      ny[i] = y * inv;
      nz[i] = z * inv;
    }
  }
  return { nx, ny, nz };
}

/**
 * Silhouette edge texels: opaque (mask != 0) texels that touch an empty (mask == 0)
 * 4-neighbour. Only the opaque side is returned, so strokes stay on the object.
 * Out-of-bounds neighbours are NOT treated as empty (a padded render never reaches the
 * border, and treating OOB as empty would ring the whole frame). Returns a w*h 0/1 byte
 * mask at render resolution.
 */
export function silhouetteEdges(aov: AovImage): Uint8Array {
  const { width: w, height: h, mask } = aov;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] === 0) continue;
      for (let k = 0; k < 4; k++) {
        const xx = x + N4_DX[k];
        const yy = y + N4_DY[k];
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        if (mask[yy * w + xx] === 0) {
          out[i] = 1;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Interior crease edge texels: opaque texels with a normal OR depth discontinuity
 * against an opaque 4-neighbour. Crease if dot(n, n_j) < normalThreshold OR
 * |d - d_j| > depthThresholdScaled * d, with depth normalized to [0,1] and the
 * threshold scaled by the texel's OWN normalized depth. Opaque/empty pairs are ignored
 * (those are silhouettes). Returns a w*h 0/1 byte mask at render resolution.
 */
export function creaseEdges(aov: AovImage, p: OutlineParams): Uint8Array {
  const { width: w, height: h, mask, depth } = aov;
  const { nx, ny, nz } = decodeNormals(aov);
  const out = new Uint8Array(w * h);
  const nt = p.normalThreshold;
  const dt = p.depthThresholdScaled;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] === 0) continue;
      const di = depth[i] * INV_65535;
      const xi = nx[i], yi = ny[i], zi = nz[i];
      for (let k = 0; k < 4; k++) {
        const xx = x + N4_DX[k];
        const yy = y + N4_DY[k];
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        const j = yy * w + xx;
        // mark the crease on ONE flank only (the lower-index texel of the pair,
        // i.e. skip left/up neighbours) so a crease dilates to the same width as
        // a silhouette rather than ~2x from being seeded on both sides (M2).
        if (j < i) continue;
        if (mask[j] === 0) continue; // opaque/empty pair is a silhouette, not a crease
        const dot = xi * nx[j] + yi * ny[j] + zi * nz[j];
        if (dot < nt) {
          out[i] = 1;
          break;
        }
        const dj = depth[j] * INV_65535;
        if (Math.abs(di - dj) > dt * di) {
          out[i] = 1;
          break;
        }
      }
    }
  }
  return out;
}

/** Grow `seeds` by `rounds` of 8-connected dilation INTO OPAQUE texels only. */
function dilate(
  seeds: Uint8Array,
  mask: Uint16Array,
  rounds: number,
  w: number,
  h: number,
): Uint8Array {
  if (rounds <= 0) return seeds;
  const n = w * h;
  let cur: Uint8Array<ArrayBufferLike> = seeds;
  let next: Uint8Array<ArrayBufferLike> = new Uint8Array(n);
  for (let r = 0; r < rounds; r++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) {
          next[i] = 1;
          continue;
        }
        if (mask[i] === 0) {
          next[i] = 0; // never grow a stroke onto an empty texel
          continue;
        }
        let on = 0;
        for (let k = 0; k < 8; k++) {
          const xx = x + N8_DX[k];
          const yy = y + N8_DY[k];
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          if (cur[yy * w + xx]) {
            on = 1;
            break;
          }
        }
        next[i] = on;
      }
    }
    const tmp = cur;
    cur = next;
    next = tmp;
  }
  return cur;
}

/**
 * Shrink an opaque region by `rounds` 8-connected steps: a texel survives only if
 * every neighbour is opaque. Used to ask whether a shape has any INTERIOR left
 * after the stroke is taken off it.
 */
function erode(mask: Uint16Array, rounds: number, w: number, h: number): Uint8Array {
  const n = w * h;
  let cur = new Uint8Array(n);
  for (let i = 0; i < n; i++) cur[i] = mask[i] === 0 ? 0 : 1;
  if (rounds <= 0) return cur;
  let next = new Uint8Array(n);
  for (let r = 0; r < rounds; r++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!cur[i]) {
          next[i] = 0;
          continue;
        }
        let keep = 1;
        for (let k = 0; k < 8; k++) {
          const xx = x + N8_DX[k];
          const yy = y + N8_DY[k];
          // Out of bounds counts as INSIDE. A shape that runs off the cell is
          // one we cannot measure past the edge, and for a sprite the
          // overwhelmingly likelier reason is that the character is LARGE —
          // treating the border as empty would erode a cell-filling character
          // from four sides and strip the outline off exactly the subjects that
          // least need it stripped.
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          if (!cur[yy * w + xx]) {
            keep = 0;
            break;
          }
        }
        next[i] = keep;
      }
    }
    const tmp = cur;
    cur = next;
    next = tmp;
  }
  return cur;
}

/**
 * Extract the outline stroke mask at render (Sx) resolution: 1 where a stroke sits.
 * `stroke = max(1, round(widthPx * superSample))`. Silhouette and crease seeds are
 * dilated SEPARATELY (8-connected, into opaque texels only) then unioned:
 *   - Silhouette grows inward (the empty side is never written), clamped by the
 *     boundary, so `stroke-1` rounds give a `stroke`-thick inward stroke that never
 *     spills into the padding.
 *   - A crease is interior (opaque both sides) so it grows BOTH ways; dilating it by
 *     only floor((stroke-1)/2) rounds gives it the SAME ~stroke width as a silhouette
 *     rather than ~2x (M2). stroke == 1 returns the 1px seeds verbatim.
 */
export function extractOutline(aov: AovImage, p: OutlineParams): Uint8Array {
  const { width: w, height: h, mask } = aov;
  const n = w * h;
  const stroke = Math.max(1, Math.round(p.widthPx * p.superSample));
  let sil = dilate(silhouetteEdges(aov), mask, stroke - 1, w, h);
  const cre = dilate(creaseEdges(aov, p), mask, Math.floor((stroke - 1) / 2), w, h);

  // minSpanPx: keep the silhouette stroke only where the shape survives an
  // OPENING by the span radius. A limb thinner than that erodes to nothing, so
  // outlining it would replace the limb rather than describe it. Creases are
  // deliberately not filtered - an interior line on a thin arm is the detail
  // that still reads at 64 px.
  const span = Math.max(0, Math.round((p.minSpanPx ?? 0) * p.superSample));
  if (span > 0) {
    const thick = dilate(erode(mask, span, w, h), mask, span, w, h);
    const kept = new Uint8Array(n);
    for (let i = 0; i < n; i++) kept[i] = sil[i] & thick[i];
    sil = kept;
  }

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = sil[i] | cre[i];
  return out;
}
