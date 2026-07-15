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
 * Near-zero vectors (empty texels encode ~0) stay at zero; creases are only ever
 * evaluated between opaque texels, whose normals are well-formed.
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

/**
 * Extract the outline stroke mask at render (Sx) resolution: 1 where a stroke sits,
 * 0 elsewhere. Silhouette OR crease edges are detected at 1px, then thickened to the
 * supersample-derived stroke width.
 *
 * Dilation approach: stroke = max(1, round(widthPx * superSample)). The 1px edge seeds
 * are grown by (stroke - 1) rounds of 8-connected dilation INTO OPAQUE TEXELS ONLY,
 * using two ping-pong buffers allocated once (every cell is rewritten each round, so no
 * stale carryover). This is equivalent to a Chebyshev distance <= stroke-1 dilation
 * clamped to mask != 0. Two consequences, both intended:
 *   - A straight silhouette grows only inward (the empty side is never written), so it
 *     ends up exactly `stroke` texels thick (seed + stroke-1 rounds), and no stroke ever
 *     expands past the silhouette into the padding.
 *   - A crease, opaque on both sides, is marked on both flanks and grows both ways.
 * stroke == 1 (rounds == 0) returns the detected edges verbatim, no dilation.
 */
export function extractOutline(aov: AovImage, p: OutlineParams): Uint8Array {
  const { width: w, height: h, mask } = aov;
  const n = w * h;

  // 1px edge seeds: silhouette OR crease (reuse the silhouette buffer as accumulator).
  const seeds = silhouetteEdges(aov);
  const crease = creaseEdges(aov, p);
  for (let i = 0; i < n; i++) seeds[i] |= crease[i];

  const stroke = Math.max(1, Math.round(p.widthPx * p.superSample));
  const rounds = stroke - 1;
  if (rounds === 0) return seeds;

  let cur: Uint8Array = seeds;
  let next: Uint8Array = new Uint8Array(n);
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
