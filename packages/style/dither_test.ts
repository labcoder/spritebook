import { test } from 'node:test';
import { assert, assertEquals } from '@std/assert';
import { bayerMatrix, bayerValue } from './dist/dither.js';

test('bayerMatrix(4) is the standard 4x4 Bayer, normalized', () => {
  const m = bayerMatrix(4);
  // classic 4x4 threshold matrix / 16
  const expected = [
    0,
    8,
    2,
    10,
    12,
    4,
    14,
    6,
    3,
    11,
    1,
    9,
    15,
    7,
    13,
    5,
  ].map((v) => v / 16);
  assertEquals([...m], expected);
});

test('bayerValue tiles by matrix size and stays in [0,1)', () => {
  const m = bayerMatrix(4);
  assertEquals(bayerValue(m, 4, 0, 0), 0);
  assertEquals(bayerValue(m, 4, 1, 0), 0.5);
  assertEquals(bayerValue(m, 4, 0, 1), 12 / 16);
  // tiling: (4,4) wraps to (0,0)
  assertEquals(bayerValue(m, 4, 4, 4), bayerValue(m, 4, 0, 0));
  for (const v of m) assert(v >= 0 && v < 1);
});

test('bayerMatrix(8) has 64 distinct evenly-spaced thresholds', () => {
  const m = bayerMatrix(8);
  assertEquals(m.length, 64);
  const scaled = new Set([...m].map((v) => Math.round(v * 64)));
  assertEquals(scaled.size, 64, 'every threshold rank 0..63 appears once');
});
