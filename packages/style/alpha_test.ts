import { assertEquals } from 'jsr:@std/assert@1';
import { cutAlpha1bit, dilateEdgeColors } from './alpha.ts';

Deno.test('cutAlpha1bit thresholds alpha to 0 or 255', () => {
  const rgba = new Uint8Array([1, 2, 3, 100, 4, 5, 6, 200]);
  cutAlpha1bit(rgba, 0.5); // cutoff 127.5
  assertEquals(rgba[3], 0, 'alpha 100 < cutoff -> 0');
  assertEquals(rgba[7], 255, 'alpha 200 >= cutoff -> 255');
  // rgb untouched
  assertEquals([rgba[0], rgba[1], rgba[2]], [1, 2, 3]);
});

Deno.test('dilateEdgeColors bleeds color into transparent rings, alpha stays 0', () => {
  // 3x3, center opaque red, rest transparent black
  const w = 3, h = 3;
  const rgba = new Uint8Array(w * h * 4);
  const c = (1 * w + 1) * 4;
  rgba[c] = 255;
  rgba[c + 3] = 255;

  dilateEdgeColors(rgba, w, h, 1);
  // 4-neighbours of centre get red rgb, alpha still 0
  for (const [x, y] of [[1, 0], [2, 1], [1, 2], [0, 1]] as const) {
    const o = (y * w + x) * 4;
    assertEquals([rgba[o], rgba[o + 3]], [255, 0], `bled at ${x},${y}`);
  }
  // corners not yet reached by a single ring
  assertEquals(rgba[(0 * w + 0) * 4], 0, 'corner untouched after 1 ring');
});

Deno.test('dilateEdgeColors extends bleedPx rings', () => {
  const w = 3, h = 3;
  const rgba = new Uint8Array(w * h * 4);
  const c = (1 * w + 1) * 4;
  rgba[c] = 255;
  rgba[c + 3] = 255;
  dilateEdgeColors(rgba, w, h, 2); // second ring reaches the corners
  assertEquals(rgba[(0 * w + 0) * 4], 255, 'corner bled on ring 2');
  assertEquals(rgba[(0 * w + 0) * 4 + 3], 0, 'corner alpha still 0');
});
