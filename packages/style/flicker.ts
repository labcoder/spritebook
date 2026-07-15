/**
 * The flicker metric (npr-sprite-stylization skill; P2-T2 acceptance): mean % of
 * changed pixels frame-to-frame across the idle loop. A temporally-stable
 * pipeline (texel-snap + cluster-vote + hysteresis + constant lighting) reads
 * near 0% on a near-static idle; crawl/shimmer pushes it up. Stored per bake in
 * BakeMetrics.flickerPct and regression-budgeted per preset. A pixel "changed"
 * if any RGBA byte differs between consecutive frames.
 */
export function flickerPct(frames: Uint8Array[], width: number, height: number): number {
  if (frames.length < 2) return 0;
  const px = width * height;
  let sum = 0;
  for (let f = 1; f < frames.length; f++) {
    const a = frames[f - 1], b = frames[f];
    let changed = 0;
    for (let p = 0; p < px; p++) {
      const o = p * 4;
      if (
        a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2] || a[o + 3] !== b[o + 3]
      ) {
        changed++;
      }
    }
    sum += changed / px;
  }
  return (sum / (frames.length - 1)) * 100;
}
