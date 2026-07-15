import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { areaAverageDownsample, clusterVoteDownsample, downsampleCoverage } from './downsample.ts';

// --- cluster-vote -----------------------------------------------------------

Deno.test('clusterVote: 2x2 block, 3x label 2 + 1x label 5 -> majority 2', () => {
  //  row0: 2 2   row1: 2 5
  const labels = Int32Array.from([2, 2, 2, 5]);
  const out = clusterVoteDownsample(labels, 2, 2, 2);
  assertEquals(out.length, 1);
  assertEquals(out[0], 2);
});

Deno.test('clusterVote: 4x4 block with a clear 3/4 majority', () => {
  const labels = new Int32Array(16).fill(2);
  labels[0] = 5;
  labels[1] = 5;
  labels[2] = 5;
  labels[3] = 5; // 4x label 5, 12x label 2 -> 2 wins
  const out = clusterVoteDownsample(labels, 4, 4, 4);
  assertEquals(out.length, 1);
  assertEquals(out[0], 2);
});

Deno.test('clusterVote: a 2v2 tie breaks to the lower label index, order-independent', () => {
  assertEquals(clusterVoteDownsample(Int32Array.from([2, 2, 5, 5]), 2, 2, 2)[0], 2);
  assertEquals(clusterVoteDownsample(Int32Array.from([5, 5, 2, 2]), 2, 2, 2)[0], 2);
  assertEquals(clusterVoteDownsample(Int32Array.from([5, 2, 2, 5]), 2, 2, 2)[0], 2);
  // three-way tie -> lowest of {1,4,7}
  assertEquals(clusterVoteDownsample(Int32Array.from([7, 4, 1, 4, 1, 7, 1, 4, 7]), 3, 3, 3)[0], 1);
});

Deno.test('clusterVote: an all-transparent block yields -1', () => {
  const labels = Int32Array.from([-1, -1, -1, -1]);
  assertEquals(clusterVoteDownsample(labels, 2, 2, 2)[0], -1);
});

Deno.test('clusterVote: -1 voters are ignored unless the block is all -1', () => {
  // wSx=4,hSx=2,s=2 -> two blocks. row0: [2 2 | -1 -1]  row1: [2 5 | -1 -1]
  // block(0): 2,2,2,5 -> 2.  block(1): all -1 -> -1.
  const labels = Int32Array.from([2, 2, -1, -1, 2, 5, -1, -1]);
  const out = clusterVoteDownsample(labels, 4, 2, 2);
  assertEquals(Array.from(out), [2, -1]);
});

Deno.test('clusterVote: partial transparency in a block does not sway the vote', () => {
  // one real vote (label 3) among three transparent -> 3
  assertEquals(clusterVoteDownsample(Int32Array.from([3, -1, -1, -1]), 2, 2, 2)[0], 3);
});

Deno.test('clusterVote: throws when the Sx grid is indivisible or mis-sized', () => {
  assertThrows(() => clusterVoteDownsample(new Int32Array(9), 3, 3, 2), RangeError);
  assertThrows(() => clusterVoteDownsample(new Int32Array(3), 2, 2, 2), RangeError); // wrong length
});

// --- area average -----------------------------------------------------------

Deno.test('areaAverage: per-channel mean of a 2x2 block is exact', () => {
  // four texels p0..p3 across the 2x2; each channel averages to a clean integer
  const rgba = Uint8Array.from([10, 20, 30, 40, 20, 40, 60, 80, 30, 60, 90, 120, 40, 80, 120, 160]);
  const out = areaAverageDownsample(rgba, 2, 2, 2);
  assertEquals(Array.from(out), [25, 50, 75, 100]);
});

Deno.test('areaAverage: half black + half white rounds to 128 (round-half-up)', () => {
  // two black texels, two white -> per-channel mean 127.5, rounds up to 128
  const rgba = Uint8Array.from([0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  const out = areaAverageDownsample(rgba, 2, 2, 2);
  assertEquals(Array.from(out), [128, 128, 128, 128]);
});

Deno.test('areaAverage: independent blocks map to their own output texels', () => {
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

Deno.test('areaAverage: throws on an indivisible or mis-sized grid', () => {
  assertThrows(() => areaAverageDownsample(new Uint8Array(4 * 4), 3, 3, 2), RangeError);
  assertThrows(() => areaAverageDownsample(new Uint8Array(4), 2, 2, 2), RangeError);
});

// --- coverage ---------------------------------------------------------------

Deno.test('coverage: a half-opaque block -> 128', () => {
  const alpha = Uint8Array.from([255, 0, 255, 0]);
  assertEquals(downsampleCoverage(alpha, 2, 2, 2)[0], 128);
});

Deno.test('coverage: fully opaque -> 255, fully empty -> 0', () => {
  assertEquals(downsampleCoverage(Uint8Array.from([255, 255, 255, 255]), 2, 2, 2)[0], 255);
  assertEquals(downsampleCoverage(Uint8Array.from([0, 0, 0, 0]), 2, 2, 2)[0], 0);
});

Deno.test('coverage: antialiased bytes average to mean coverage', () => {
  // (0 + 255 + 128 + 64) = 447; /4 = 111.75 -> 112 (round-half-up)
  assertEquals(downsampleCoverage(Uint8Array.from([0, 255, 128, 64]), 2, 2, 2)[0], 112);
});

Deno.test('coverage: 1/4 opaque -> 64, 3/4 opaque -> 191', () => {
  assertEquals(downsampleCoverage(Uint8Array.from([255, 0, 0, 0]), 2, 2, 2)[0], 64);
  assertEquals(downsampleCoverage(Uint8Array.from([255, 255, 255, 0]), 2, 2, 2)[0], 191);
});

Deno.test('coverage: independent blocks (one full, one half)', () => {
  // wSx=4,hSx=2,s=2 -> two outputs. row0: [255 255 | 255 0]  row1: [255 255 | 0 255]
  // block(0): all 255 -> 255.  block(1): 255,0,0,255 -> 128.
  const alpha = Uint8Array.from([255, 255, 255, 0, 255, 255, 0, 255]);
  const out = downsampleCoverage(alpha, 4, 2, 2);
  assertEquals(Array.from(out), [255, 128]);
});

Deno.test('coverage: throws on an indivisible or mis-sized grid', () => {
  assertThrows(() => downsampleCoverage(new Uint8Array(9), 3, 3, 2), RangeError);
  assertThrows(() => downsampleCoverage(new Uint8Array(3), 2, 2, 2), RangeError);
});
