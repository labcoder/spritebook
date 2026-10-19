import { test } from 'node:test';
import { assertEquals, assertThrows } from '@std/assert';
import {
  areaAverageDownsample,
  clusterVoteDownsample,
  downsampleCoverage,
} from './dist/downsample.js';

// --- cluster-vote -----------------------------------------------------------

test('clusterVote: 2x2 block, 3x label 2 + 1x label 5 -> majority 2', () => {
  //  row0: 2 2   row1: 2 5
  const labels = Int32Array.from([2, 2, 2, 5]);
  const out = clusterVoteDownsample(labels, 2, 2, 2);
  assertEquals(out.length, 1);
  assertEquals(out[0], 2);
});

test('clusterVote: 4x4 block with a clear 3/4 majority', () => {
  const labels = new Int32Array(16).fill(2);
  labels[0] = 5;
  labels[1] = 5;
  labels[2] = 5;
  labels[3] = 5; // 4x label 5, 12x label 2 -> 2 wins
  const out = clusterVoteDownsample(labels, 4, 4, 4);
  assertEquals(out.length, 1);
  assertEquals(out[0], 2);
});

test('clusterVote: a 2v2 tie breaks to the lower label index, order-independent', () => {
  assertEquals(clusterVoteDownsample(Int32Array.from([2, 2, 5, 5]), 2, 2, 2)[0], 2);
  assertEquals(clusterVoteDownsample(Int32Array.from([5, 5, 2, 2]), 2, 2, 2)[0], 2);
  assertEquals(clusterVoteDownsample(Int32Array.from([5, 2, 2, 5]), 2, 2, 2)[0], 2);
  // three-way tie -> lowest of {1,4,7}
  assertEquals(clusterVoteDownsample(Int32Array.from([7, 4, 1, 4, 1, 7, 1, 4, 7]), 3, 3, 3)[0], 1);
});

test('clusterVote: an all-transparent block yields -1', () => {
  const labels = Int32Array.from([-1, -1, -1, -1]);
  assertEquals(clusterVoteDownsample(labels, 2, 2, 2)[0], -1);
});

test('clusterVote: -1 voters are ignored unless the block is all -1', () => {
  // wSx=4,hSx=2,s=2 -> two blocks. row0: [2 2 | -1 -1]  row1: [2 5 | -1 -1]
  // block(0): 2,2,2,5 -> 2.  block(1): all -1 -> -1.
  const labels = Int32Array.from([2, 2, -1, -1, 2, 5, -1, -1]);
  const out = clusterVoteDownsample(labels, 4, 2, 2);
  assertEquals(Array.from(out), [2, -1]);
});

test('clusterVote: partial transparency in a block does not sway the vote', () => {
  // one real vote (label 3) among three transparent -> 3
  assertEquals(clusterVoteDownsample(Int32Array.from([3, -1, -1, -1]), 2, 2, 2)[0], 3);
});

test('clusterVote: throws when the Sx grid is indivisible or mis-sized', () => {
  assertThrows(() => clusterVoteDownsample(new Int32Array(9), 3, 3, 2), RangeError);
  assertThrows(() => clusterVoteDownsample(new Int32Array(3), 2, 2, 2), RangeError); // wrong length
});

// --- area average -----------------------------------------------------------

test('areaAverage: colour is the ALPHA-WEIGHTED mean, alpha is the area mean', () => {
  // four texels p0..p3 with rising alpha (40, 80, 120, 160). This previously
  // expected [25, 50, 75, 100] — the plain unweighted mean — which is the
  // defect: a texel contributing 40/255 of a pixel's coverage was given the
  // same say in its colour as one contributing 160/255.
  //   sum(a)          = 400
  //   sum(r*a)        = 10*40 + 20*80 + 30*120 + 40*160 = 12000  -> 30
  //   alpha (area)    = 400 / 4                                  -> 100
  const rgba = Uint8Array.from([10, 20, 30, 40, 20, 40, 60, 80, 30, 60, 90, 120, 40, 80, 120, 160]);
  const out = areaAverageDownsample(rgba, 2, 2, 2);
  assertEquals(Array.from(out), [30, 60, 90, 100]);
});

test('areaAverage: EMPTY texels do not darken the covered ones', () => {
  // Two texels at (0,0,0,0) and two opaque white. This previously expected
  // [128,128,128,128] under the name "half black + half white" — but those
  // texels are not black, they are EMPTY: alpha 0 means nothing was drawn
  // there. Averaging their zero RGB into the result is precisely how painterly
  // grew a dark rim. The block is white, covered half the time.
  const rgba = Uint8Array.from([0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  const out = areaAverageDownsample(rgba, 2, 2, 2);
  assertEquals(Array.from(out), [255, 255, 255, 128]);
});

test('areaAverage: independent blocks map to their own output texels', () => {
  // wSx=4,hSx=2,s=2 -> two output pixels; left block all 100, right block all 200.
  const rgba = new Uint8Array(4 * 2 * 4);
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 2; y++) {
      const i = (y * 4 + x) * 4;
      rgba.fill(x < 2 ? 100 : 200, i, i + 4);
    }
  }
  const out = areaAverageDownsample(rgba, 4, 2, 2);
  assertEquals(Array.from(out), [100, 100, 100, 100, 200, 200, 200, 200]);
});

test('areaAverage: throws on an indivisible or mis-sized grid', () => {
  assertThrows(() => areaAverageDownsample(new Uint8Array(4 * 4), 3, 3, 2), RangeError);
  assertThrows(() => areaAverageDownsample(new Uint8Array(4), 2, 2, 2), RangeError);
});

// --- coverage ---------------------------------------------------------------

test('coverage: a half-opaque block -> 128', () => {
  const alpha = Uint8Array.from([255, 0, 255, 0]);
  assertEquals(downsampleCoverage(alpha, 2, 2, 2)[0], 128);
});

test('coverage: fully opaque -> 255, fully empty -> 0', () => {
  assertEquals(downsampleCoverage(Uint8Array.from([255, 255, 255, 255]), 2, 2, 2)[0], 255);
  assertEquals(downsampleCoverage(Uint8Array.from([0, 0, 0, 0]), 2, 2, 2)[0], 0);
});

test('coverage: antialiased bytes average to mean coverage', () => {
  // (0 + 255 + 128 + 64) = 447; /4 = 111.75 -> 112 (round-half-up)
  assertEquals(downsampleCoverage(Uint8Array.from([0, 255, 128, 64]), 2, 2, 2)[0], 112);
});

test('coverage: 1/4 opaque -> 64, 3/4 opaque -> 191', () => {
  assertEquals(downsampleCoverage(Uint8Array.from([255, 0, 0, 0]), 2, 2, 2)[0], 64);
  assertEquals(downsampleCoverage(Uint8Array.from([255, 255, 255, 0]), 2, 2, 2)[0], 191);
});

test('coverage: independent blocks (one full, one half)', () => {
  // wSx=4,hSx=2,s=2 -> two outputs. row0: [255 255 | 255 0]  row1: [255 255 | 0 255]
  // block(0): all 255 -> 255.  block(1): 255,0,0,255 -> 128.
  const alpha = Uint8Array.from([255, 255, 255, 0, 255, 255, 0, 255]);
  const out = downsampleCoverage(alpha, 4, 2, 2);
  assertEquals(Array.from(out), [255, 128]);
});

test('coverage: throws on an indivisible or mis-sized grid', () => {
  assertThrows(() => downsampleCoverage(new Uint8Array(9), 3, 3, 2), RangeError);
  assertThrows(() => downsampleCoverage(new Uint8Array(3), 2, 2, 2), RangeError);
});

test('areaAverage: colour is weighted by coverage, not diluted by empty texels', () => {
  // The defect: summing r,g,b over cleared (0,0,0,0) texels and dividing by the
  // full area mixes transparent black into every partial-coverage block. A 4x4
  // block half covered by rgb(200,0,0) came out rgb(100,0,0) - 2.00x too dark -
  // which put a dark rim on painterly, the one preset that ships no outline.
  const s = 4;
  const rgba = new Uint8Array(s * s * 4); // starts fully transparent black
  for (let i = 0; i < 8; i++) {
    rgba[i * 4] = 200;
    rgba[i * 4 + 3] = 255; // 8 of 16 texels opaque red
  }
  const out = areaAverageDownsample(rgba, s, s, s);
  assertEquals(
    [out[0], out[1], out[2]],
    [200, 0, 0],
    'the covered colour survives at full strength; [100,0,0] is the old bug',
  );
  assertEquals(out[3], 128, 'alpha is still the AREA mean: 8/16 -> 128');
});

test('areaAverage: a fully opaque block is unchanged by the weighting', () => {
  // Why the styled goldens move only along coverage boundaries: when every
  // alpha is 255 the weight factors out of numerator and denominator exactly.
  const s = 2;
  const rgba = new Uint8Array([
    10,
    20,
    30,
    255,
    40,
    60,
    80,
    255,
    12,
    22,
    32,
    255,
    38,
    58,
    78,
    255,
  ]);
  const out = areaAverageDownsample(rgba, s, s, s);
  assertEquals([out[0], out[1], out[2], out[3]], [25, 40, 55, 255]);
});

test('areaAverage: a fully transparent block reports nothing, not black', () => {
  const s = 2;
  const out = areaAverageDownsample(new Uint8Array(s * s * 4), s, s, s);
  assertEquals([out[0], out[1], out[2], out[3]], [0, 0, 0, 0]);
});

test('areaAverage: partial coverage of two colours weights by their alphas', () => {
  // one texel fully opaque red, one half-alpha blue, two empty:
  // colour = (200*255 + 0*128)/(255+128) for r, (0*255 + 200*128)/383 for b
  const s = 2;
  const rgba = new Uint8Array([
    200,
    0,
    0,
    255,
    0,
    0,
    200,
    128,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  const out = areaAverageDownsample(rgba, s, s, s);
  const denom = 255 + 128;
  assertEquals(out[0], ((200 * 255 + (denom >> 1)) / denom) | 0, 'red weighted by its alpha');
  assertEquals(out[2], ((200 * 128 + (denom >> 1)) / denom) | 0, 'blue weighted by its alpha');
  assertEquals(out[3], ((denom + 2) / 4) | 0, 'alpha stays the area mean');
});
