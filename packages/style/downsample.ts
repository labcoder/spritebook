/**
 * Sx -> 1x downsamplers for the NPR stack (P2-T2, npr-sprite-stylization skill). PURE
 * CPU over decoded buffers — no GPU, no files. Step 4 of the pipeline, run AFTER outline
 * composite and BEFORE (cluster-vote) or WITHOUT (area-average) palette quantization.
 *
 * Cluster-vote is the product's temporal-stability differentiator: for quantized (pixel)
 * styles we quantize the Sx subpixels to palette LABELS first, then take the majority
 * label per 1x block. NEVER average colors then quantize — averaging invents in-between
 * colors whose nearest palette entry flips frame to frame, which is exactly the flicker
 * this tool exists to kill. Area-average is only for painterly/cel (non-quantized)
 * styles; coverage downsampling feeds the later 1-bit alpha cut.
 *
 * All three assume wSx % s === 0 and hSx % s === 0 (they throw otherwise) and are
 * deterministic: fixed iteration order, integer rounding, no Math.random, no clock.
 */

/** Throw unless the Sx grid divides evenly into s*s blocks. */
function assertBlockGrid(wSx: number, hSx: number, s: number): void {
  if (!Number.isInteger(s) || s < 1) {
    throw new RangeError(`downsample factor s must be a positive integer, got ${s}`);
  }
  if (wSx % s !== 0 || hSx % s !== 0) {
    throw new RangeError(`Sx dims ${wSx}x${hSx} must both be divisible by downsample factor ${s}`);
  }
}

/** Throw unless `buf` holds exactly `expected` elements (guards a mismatched Sx grid). */
function assertLength(name: string, len: number, expected: number): void {
  if (len !== expected) {
    throw new RangeError(`${name} length ${len} does not match Sx grid (expected ${expected})`);
  }
}

/**
 * Cluster-vote downsample: `labels` is the Sx palette-index map (one int per Sx texel,
 * -1 == transparent). For each 1x pixel, return the MAJORITY label over its s*s block,
 * ignoring -1 (transparent) unless the block is entirely -1 (then -1). Ties break to the
 * LOWEST label index — deterministic regardless of scan order. Output is (wSx/s)*(hSx/s).
 *
 * Histogram strategy: one Int32Array counts, sized to the max label; per block we touch
 * only the labels present (tracked in a small `seen` scratch) and reset just those,
 * keeping the whole pass O(wSx*hSx) with no per-block allocation.
 */
export function clusterVoteDownsample(
  labels: Int32Array,
  wSx: number,
  hSx: number,
  s: number,
): Int32Array {
  assertBlockGrid(wSx, hSx, s);
  assertLength('labels', labels.length, wSx * hSx);
  const w = wSx / s;
  const h = hSx / s;
  const out = new Int32Array(w * h);

  let maxLabel = -1;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] > maxLabel) maxLabel = labels[i];
  }
  if (maxLabel < 0) {
    out.fill(-1); // every texel transparent -> every 1x pixel transparent
    return out;
  }

  const counts = new Int32Array(maxLabel + 1);
  const seen = new Int32Array(s * s);
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      const baseY = oy * s;
      const baseX = ox * s;
      let seenCount = 0;
      for (let dy = 0; dy < s; dy++) {
        const row = (baseY + dy) * wSx + baseX;
        for (let dx = 0; dx < s; dx++) {
          const l = labels[row + dx];
          if (l < 0) continue; // skip transparent voters
          if (counts[l] === 0) seen[seenCount++] = l;
          counts[l]++;
        }
      }
      let best = -1;
      let bestCount = -1;
      for (let k = 0; k < seenCount; k++) {
        const l = seen[k];
        const c = counts[l];
        // strictly-greater wins; on a tie the LOWER label index wins (order-independent)
        if (c > bestCount || (c === bestCount && l < best)) {
          bestCount = c;
          best = l;
        }
        counts[l] = 0; // reset touched bins for the next block
      }
      out[oy * w + ox] = best; // seenCount === 0 (all transparent) leaves best === -1
    }
  }
  return out;
}

/**
 * Straight-alpha area average -> 1x rgba8, for the styles that do not quantize.
 *
 * Alpha is an AREA mean (coverage really is "what fraction of this block was
 * covered"), but colour is weighted BY that coverage: summing r,g,b over the
 * cleared (0,0,0,0) texels and dividing by the full area mixes transparent
 * black into every partial-coverage block, which darkens exactly the pixels at
 * the silhouette edge. Measured before this fix: a 4x4 block half-covered by
 * rgb(200,0,0) came out rgb(100,0,0) — 2.00x too dark — giving painterly, the
 * one preset that deliberately ships no outline, an unintended dark rim.
 *
 * Formally this is the premultiplied mean, unpremultiplied at the end:
 *   colour = sum(rgb_i * a_i) / sum(a_i),   alpha = sum(a_i) / area
 * A fully-opaque block is unchanged (every a_i is 255, so the weight factors
 * out), which is why the styled goldens move only along coverage boundaries.
 * A fully-transparent block has no colour to report and stays (0,0,0,0).
 *
 * Rounding stays round-half-up via an integer bias. Output is
 * (wSx/s)*(hSx/s)*4 bytes.
 */
export function areaAverageDownsample(
  rgba: Uint8Array,
  wSx: number,
  hSx: number,
  s: number,
): Uint8Array {
  assertBlockGrid(wSx, hSx, s);
  assertLength('rgba', rgba.length, wSx * hSx * 4);
  const w = wSx / s;
  const h = hSx / s;
  const out = new Uint8Array(w * h * 4);
  const area = s * s;
  const half = area >> 1; // round-half-up bias; exact for even and odd area with int sums

  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      const baseY = oy * s;
      const baseX = ox * s;
      // r,g,b are accumulated PREMULTIPLIED (weighted by each texel's alpha);
      // `a` is the plain coverage sum used both to unpremultiply and to report
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < s; dy++) {
        let idx = ((baseY + dy) * wSx + baseX) * 4;
        for (let dx = 0; dx < s; dx++) {
          const w8 = rgba[idx + 3];
          r += rgba[idx] * w8;
          g += rgba[idx + 1] * w8;
          b += rgba[idx + 2] * w8;
          a += w8;
          idx += 4;
        }
      }
      const o = (oy * w + ox) * 4;
      if (a === 0) continue; // nothing covered: leave (0,0,0,0)
      const bias = a >> 1;
      out[o] = ((r + bias) / a) | 0;
      out[o + 1] = ((g + bias) / a) | 0;
      out[o + 2] = ((b + bias) / a) | 0;
      out[o + 3] = ((a + half) / area) | 0;
    }
  }
  return out;
}

/**
 * Coverage downsample: `alphaSx` is one byte per Sx texel (0/255, or 0..255 antialiased).
 * Each 1x pixel is the block MEAN of the alpha byte, 0..255 — i.e. the opaque fraction
 * scaled to 255 for binary input, or mean coverage for antialiased input. A later 1-bit
 * alpha cut thresholds this. Rounding is round-half-up. Output is (wSx/s)*(hSx/s) bytes.
 */
export function downsampleCoverage(
  alphaSx: Uint8Array,
  wSx: number,
  hSx: number,
  s: number,
): Uint8Array {
  assertBlockGrid(wSx, hSx, s);
  assertLength('alphaSx', alphaSx.length, wSx * hSx);
  const w = wSx / s;
  const h = hSx / s;
  const out = new Uint8Array(w * h);
  const area = s * s;
  const half = area >> 1;

  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      const baseY = oy * s;
      const baseX = ox * s;
      let sum = 0;
      for (let dy = 0; dy < s; dy++) {
        const row = (baseY + dy) * wSx + baseX;
        for (let dx = 0; dx < s; dx++) sum += alphaSx[row + dx];
      }
      out[oy * w + ox] = ((sum + half) / area) | 0;
    }
  }
  return out;
}
