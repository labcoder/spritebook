import { assertEquals } from 'jsr:@std/assert@1';
import type { AovImage, OutlineParams } from './contracts.ts';
import { creaseEdges, extractOutline, silhouetteEdges } from './outline.ts';

// --- synthetic AOV builders -------------------------------------------------

/** A blank w*h AOV: all planes zeroed (mask 0 == empty everywhere). */
function blankAov(w: number, h: number): AovImage {
  return {
    width: w,
    height: h,
    lit: new Uint8Array(w * h * 4),
    albedo: new Uint8Array(w * h * 4),
    normal: new Uint8Array(w * h * 4),
    depth: new Uint16Array(w * h),
    mask: new Uint16Array(w * h),
  };
}

/** Encode a unit normal into the AOV at texel i: byte = round((n*0.5+0.5)*255). */
function setNormal(aov: AovImage, i: number, n: readonly [number, number, number]): void {
  const b = i * 4;
  aov.normal[b] = Math.round((n[0] * 0.5 + 0.5) * 255);
  aov.normal[b + 1] = Math.round((n[1] * 0.5 + 0.5) * 255);
  aov.normal[b + 2] = Math.round((n[2] * 0.5 + 0.5) * 255);
  aov.normal[b + 3] = 255;
}

function params(o: Partial<OutlineParams> = {}): OutlineParams {
  return {
    superSample: 1,
    widthPx: 1,
    normalThreshold: 0.5,
    depthThresholdScaled: 1.0,
    ...o,
  };
}

const W = 16;
const H = 16;
const SEAM = 8; // columns 0..7 = left region, 8..15 = right region

/** Fill the whole frame opaque with one flat normal and one flat depth. */
function flatOpaque(n: readonly [number, number, number], depth: number): AovImage {
  const aov = blankAov(W, H);
  for (let i = 0; i < W * H; i++) {
    aov.mask[i] = 1;
    aov.depth[i] = depth;
    setNormal(aov, i, n);
  }
  return aov;
}

// --- crease detection -------------------------------------------------------

Deno.test('crease: two flat normal regions -> crease exactly on the seam', () => {
  const aov = flatOpaque([0, 0, 1], 30000);
  // right region faces a perpendicular direction -> dot(A,B) = 0 < 0.5
  for (let y = 0; y < H; y++) {
    for (let x = SEAM; x < W; x++) setNormal(aov, y * W + x, [1, 0, 0]);
  }
  // stroke == 1: no dilation, so the raw seam is asserted.
  const out = extractOutline(aov, params({ superSample: 1, widthPx: 1 }));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const expected = x === SEAM - 1 ? 1 : 0; // single (lower-index) flank, M2
      assertEquals(out[y * W + x], expected, `crease at (${x},${y})`);
    }
  }
});

Deno.test('crease: a depth step is detected on the seam (normals flat)', () => {
  const aov = flatOpaque([0, 0, 1], 10000); // identical normals -> no normal crease
  for (let y = 0; y < H; y++) {
    for (let x = SEAM; x < W; x++) aov.depth[y * W + x] = 40000;
  }
  // |0.153 - 0.610| = 0.458 exceeds the scaled threshold -> crease on the left flank.
  const out = extractOutline(aov, params({ depthThresholdScaled: 0.5, normalThreshold: 0.5 }));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const expected = x === SEAM - 1 ? 1 : 0;
      assertEquals(out[y * W + x], expected, `depth crease at (${x},${y})`);
    }
  }
});

Deno.test('crease: a flat opaque frame has no interior edges', () => {
  const aov = flatOpaque([0, 0, 1], 30000);
  const crease = creaseEdges(aov, params());
  assertEquals(crease.reduce((a, b) => a + b, 0), 0);
  // fully opaque -> no silhouette either
  const sil = silhouetteEdges(aov);
  assertEquals(sil.reduce((a, b) => a + b, 0), 0);
});

Deno.test('crease: depth threshold scales with depth (same step, near creases, far does not)', () => {
  // Two single-seam frames with the SAME 2000-unit step, one near, one far. The scaled
  // threshold fires on the near seam and lets the identical far seam survive.
  const step = 2000;
  const near = flatOpaque([0, 0, 1], 1000); // right half -> 3000
  const far = flatOpaque([0, 0, 1], 60000); // right half -> 62000
  for (let y = 0; y < H; y++) {
    for (let x = SEAM; x < W; x++) {
      near.depth[y * W + x] = 1000 + step;
      far.depth[y * W + x] = 60000 + step;
    }
  }
  const p = params({ depthThresholdScaled: 0.5, normalThreshold: 0.5 });
  const nearCrease = creaseEdges(near, p);
  const farCrease = creaseEdges(far, p);
  // near: step 0.0305 > 0.5*(1000/65535)=0.0076 -> crease on the left (lower-index) flank
  for (let y = 0; y < H; y++) {
    assertEquals(nearCrease[y * W + (SEAM - 1)], 1, `near crease col ${SEAM - 1} @${y}`);
    assertEquals(nearCrease[y * W + SEAM], 0, `right flank not marked @${y}`);
  }
  // far: step 0.0305 < 0.5*(60000/65535)=0.4578 -> no crease anywhere
  assertEquals(farCrease.reduce((a, b) => a + b, 0), 0);
});

// --- silhouette detection ---------------------------------------------------

/** Left half (x < SEAM) opaque, right half empty; one flat normal/depth in the object. */
function halfOpaque(): AovImage {
  const aov = blankAov(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < SEAM; x++) {
      const i = y * W + x;
      aov.mask[i] = 1;
      aov.depth[i] = 30000;
      setNormal(aov, i, [0, 0, 1]);
    }
  }
  return aov;
}

Deno.test('silhouette: mask boundary marks the opaque side only (1px, stroke 1)', () => {
  const aov = halfOpaque();
  const out = extractOutline(aov, params({ superSample: 1, widthPx: 1 }));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const expected = x === SEAM - 1 ? 1 : 0; // only the last opaque column
      assertEquals(out[y * W + x], expected, `silhouette at (${x},${y})`);
    }
  }
});

Deno.test('silhouette: helper isolates the boundary; no crease in a flat object', () => {
  const aov = halfOpaque();
  const sil = silhouetteEdges(aov);
  const crease = creaseEdges(aov, params());
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      assertEquals(sil[y * W + x], x === SEAM - 1 ? 1 : 0, `sil (${x},${y})`);
    }
  }
  assertEquals(crease.reduce((a, b) => a + b, 0), 0); // flat interior -> no creases
});

// --- stroke width / dilation ------------------------------------------------

Deno.test('stroke width: widthPx=1, S=4 -> exactly 4px thick, growing inward', () => {
  const aov = halfOpaque();
  const out = extractOutline(aov, params({ superSample: 4, widthPx: 1 }));
  // stroke = round(1*4) = 4 -> columns 4,5,6,7 (inward from the boundary at 7)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inStroke = x >= 4 && x <= 7;
      assertEquals(out[y * W + x], inStroke ? 1 : 0, `stroke at (${x},${y})`);
    }
  }
});

Deno.test('stroke width: stroke never lands on an empty (mask==0) texel', () => {
  const aov = halfOpaque();
  for (const [S, wpx] of [[1, 1], [2, 1], [4, 1], [4, 2]] as const) {
    const out = extractOutline(aov, params({ superSample: S, widthPx: wpx }));
    for (let i = 0; i < W * H; i++) {
      if (aov.mask[i] === 0) assertEquals(out[i], 0, `empty texel ${i} set for S=${S} w=${wpx}`);
    }
  }
});

Deno.test('stroke width: rounds up from the supersample factor (widthPx=2, S=3 -> 6px)', () => {
  const aov = halfOpaque();
  const out = extractOutline(aov, params({ superSample: 3, widthPx: 2 }));
  // stroke = round(2*3) = 6 -> columns 2..7
  let thickness = 0;
  for (let x = 0; x < W; x++) if (out[x]) thickness++; // row 0
  assertEquals(thickness, 6);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      assertEquals(out[y * W + x], x >= 2 && x <= 7 ? 1 : 0, `6px stroke at (${x},${y})`);
    }
  }
});

// --- determinism ------------------------------------------------------------

Deno.test('extractOutline is deterministic (byte-identical across calls)', () => {
  const aov = halfOpaque();
  for (let y = 0; y < H; y++) {
    for (let x = SEAM; x < W; x++) aov.mask[y * W + x] = 0; // keep the silhouette
  }
  const p = params({ superSample: 4, widthPx: 1 });
  const a = extractOutline(aov, p);
  const b = extractOutline(aov, p);
  assertEquals(Array.from(a), Array.from(b));
});

// --- thin subjects: sub-pixel width, and dropping the stroke on thin spans ----

/** A vertical opaque bar `barW` texels wide, centred, on its OWN frame.
 * Its own, because these cases need room for a 10 px limb at S=4 and the
 * module-level 16x16 cannot hold one. */
function bar(barW: number, w = 64, h = 64): AovImage {
  const aov = blankAov(w, h);
  const x0 = Math.floor((w - barW) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = x0; x < x0 + barW; x++) {
      const i = y * w + x;
      aov.mask[i] = 1;
      aov.depth[i] = 30000;
      setNormal(aov, i, [0, 0, 1]);
    }
  }
  return aov;
}

function strokeShare(out: Uint8Array, aov: AovImage): number {
  let opaque = 0, stroked = 0;
  for (let i = 0; i < out.length; i++) {
    if (aov.mask[i] === 0) continue;
    opaque++;
    if (out[i]) stroked++;
  }
  return stroked / opaque;
}

Deno.test('outline: a fractional widthPx thins the stroke instead of rounding to 1', () => {
  // pixel-8 shipped widthPx as an INTEGER with a floor of 1, so a 64 px cell had
  // no thinner setting. On a slim character a 1 px inward stroke from both sides
  // of a 3 px limb IS the limb — measured at 67% of bulma's silhouette. The
  // render is supersampled, so a half pixel is expressible: 0.5 x S=4 is a
  // 2-texel Sx stroke where 1.0 is 4.
  const aov = bar(12); // 12 texels wide at S=4 == a 3 px limb at 1x
  const full = extractOutline(aov, params({ superSample: 4, widthPx: 1 }));
  const half = extractOutline(aov, params({ superSample: 4, widthPx: 0.5 }));
  const fullShare = strokeShare(full, aov);
  const halfShare = strokeShare(half, aov);
  assertEquals(fullShare > halfShare, true, `${fullShare} should exceed ${halfShare}`);
  // 4 texels in from each side of 12 = 8/12; 2 from each side = 4/12
  assertEquals(Math.round(fullShare * 12), 8);
  assertEquals(Math.round(halfShare * 12), 4);
});

Deno.test('outline: minSpanPx drops the stroke on a limb too thin to survive it', () => {
  const thin = bar(8); // 2 px at 1x — an outline would leave no interior
  const thick = bar(40); // 10 px at 1x — plenty of inside
  const p = params({ superSample: 4, widthPx: 1, minSpanPx: 2 });

  assertEquals(strokeShare(extractOutline(thin, p), thin), 0, 'thin bar keeps no silhouette');
  assertEquals(
    strokeShare(extractOutline(thick, p), thick) > 0,
    true,
    'a thick bar still gets its outline',
  );
  // and it is OPT-IN: without minSpanPx the thin bar is outlined as before
  assertEquals(
    strokeShare(extractOutline(thin, params({ superSample: 4, widthPx: 1 })), thin) > 0,
    true,
    'default behaviour is unchanged',
  );
});

Deno.test('outline: minSpanPx spares CREASES, which are the detail that still reads', () => {
  // A thin limb loses its silhouette but must keep interior lines — otherwise
  // suppression trades a black limb for a featureless one.
  const aov = bar(8);
  for (let y = 0; y < aov.height; y++) {
    for (let x = aov.width / 2; x < aov.width; x++) {
      if (aov.mask[y * aov.width + x]) setNormal(aov, y * aov.width + x, [1, 0, 0]);
    }
  }
  const out = extractOutline(aov, params({ superSample: 4, widthPx: 1, minSpanPx: 2 }));
  assertEquals(strokeShare(out, aov) > 0, true, 'the crease survives on a thin span');
});
