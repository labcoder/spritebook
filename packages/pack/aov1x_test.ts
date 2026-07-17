import { assert, assertEquals, assertNotStrictEquals, assertThrows } from 'jsr:@std/assert@1';
import type { AovImage } from '@spritebook/style';
import { aov1x } from './aov1x.ts';

/** A zeroed AovImage of the given Sx size (tests fill the planes they assert on). */
function makeAov(width: number, height: number): AovImage {
  return {
    width,
    height,
    lit: new Uint8Array(width * height * 4),
    albedo: new Uint8Array(width * height * 4),
    normal: new Uint8Array(width * height * 4),
    depth: new Uint16Array(width * height),
    mask: new Uint16Array(width * height),
  };
}

Deno.test('aov1x: albedo is the s*s area average per channel, alpha included, half rounds up', () => {
  const aov = makeAov(4, 4);
  for (let i = 0; i < 16; i++) {
    aov.albedo[i * 4] = i; // r: 0..15 -> mean 7.5 -> 8
    aov.albedo[i * 4 + 1] = 10; // g: constant -> 10
    aov.albedo[i * 4 + 2] = i < 8 ? 0 : 1; // b: mean 0.5 -> 1
    aov.albedo[i * 4 + 3] = i < 8 ? 0 : 255; // a: mean 127.5 -> 128
  }
  const out = aov1x(aov, 4);
  assertEquals(out.albedo.w, 1);
  assertEquals(out.albedo.h, 1);
  assertEquals([...out.albedo.rgba!], [8, 10, 1, 128]);
});

Deno.test("aov1x: albedo rounding is round-half-up, not banker's or truncation", () => {
  // 2x2 blocks (s=2, area 4): sums 1, 2, 3 -> means 0.25, 0.5, 0.75 -> 0, 1, 1
  const cases: Array<[number[], number]> = [
    [[1, 0, 0, 0], 0],
    [[1, 1, 0, 0], 1],
    [[3, 0, 0, 0], 1],
  ];
  for (const [values, expected] of cases) {
    const aov = makeAov(2, 2);
    values.forEach((v, i) => (aov.albedo[i * 4] = v));
    assertEquals(aov1x(aov, 2).albedo.rgba![0], expected, `block ${values} -> ${expected}`);
  }
});

Deno.test('aov1x: normal/depth/mask center-tap picks the (2,2)-of-4 subpixel', () => {
  const aov = makeAov(4, 4);
  for (let i = 0; i < 16; i++) {
    aov.normal[i * 4] = 50 + i;
    aov.normal[i * 4 + 1] = 100 + i;
    aov.normal[i * 4 + 2] = 150 + i;
    aov.normal[i * 4 + 3] = 200 + i;
    aov.depth[i] = 1000 + i;
    aov.mask[i] = 0xf000 + i;
  }
  const out = aov1x(aov, 4);
  const tap = 2 * 4 + 2; // subpixel (2,2) of the 4x4 block -> index 10
  assertEquals([...out.normal.rgba!], [50 + tap, 100 + tap, 150 + tap, 200 + tap]);
  assertEquals(out.depth.gray16![0], 1000 + tap);
  assertEquals(out.mask.gray16![0], 0xf000 + tap); // 16-bit value survives untouched
});

Deno.test('aov1x: center-tap lands per block, not per image (8x4, s=4 -> 2x1)', () => {
  const aov = makeAov(8, 4);
  for (let i = 0; i < 32; i++) aov.depth[i] = i;
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 4; y++) {
      aov.albedo[(y * 8 + x) * 4] = x < 4 ? 4 : 8; // r averages 4 then 8
    }
  }
  const out = aov1x(aov, 4);
  assertEquals(out.depth.w, 2);
  assertEquals(out.depth.h, 1);
  assertEquals([...out.depth.gray16!], [2 * 8 + 2, 2 * 8 + 6]); // taps (2,2) and (6,2)
  assertEquals([out.albedo.rgba![0], out.albedo.rgba![4]], [4, 8]);
});

Deno.test('aov1x: even s taps floor(s/2) — the lower-right of a 2x2 block', () => {
  const aov = makeAov(2, 2);
  aov.depth.set([5, 6, 7, 8]);
  aov.mask.set([50, 60, 70, 80]);
  const out = aov1x(aov, 2);
  assertEquals(out.depth.gray16![0], 8); // subpixel (1,1)
  assertEquals(out.mask.gray16![0], 80);
});

Deno.test('aov1x: s=1 is identity on fresh buffers', () => {
  const aov = makeAov(2, 2);
  aov.albedo.set(Uint8Array.from({ length: 16 }, (_, i) => 30 + i));
  aov.normal.set(Uint8Array.from({ length: 16 }, (_, i) => 60 + i));
  aov.depth.set([1, 2, 3, 4]);
  aov.mask.set([5, 6, 7, 8]);
  const out = aov1x(aov, 1);
  assertEquals(out.albedo.rgba, aov.albedo);
  assertEquals(out.normal.rgba, aov.normal);
  assertEquals(out.depth.gray16, aov.depth);
  assertEquals(out.mask.gray16, aov.mask);
  assertNotStrictEquals(out.albedo.rgba, aov.albedo); // copies, not aliases
  assertNotStrictEquals(out.depth.gray16, aov.depth);
});

Deno.test('aov1x: output planes carry the right kinds and sizes', () => {
  const out = aov1x(makeAov(8, 4), 4);
  for (const plane of [out.albedo, out.normal]) {
    assertEquals([plane.w, plane.h], [2, 1]);
    assertEquals(plane.rgba!.length, 2 * 1 * 4);
    assertEquals(plane.gray16, undefined);
  }
  for (const plane of [out.depth, out.mask]) {
    assertEquals([plane.w, plane.h], [2, 1]);
    assertEquals(plane.gray16!.length, 2);
    assertEquals(plane.rgba, undefined);
  }
});

Deno.test('aov1x: indivisible dimensions and bad factors throw', () => {
  assertThrows(() => aov1x(makeAov(6, 4), 4), RangeError, 'divisible');
  assertThrows(() => aov1x(makeAov(4, 6), 4), RangeError, 'divisible');
  assertThrows(() => aov1x(makeAov(4, 4), 0), RangeError, 'positive integer');
  assertThrows(() => aov1x(makeAov(4, 4), -4), RangeError, 'positive integer');
  assertThrows(() => aov1x(makeAov(4, 4), 2.5), RangeError, 'positive integer');
});

Deno.test('aov1x: a mis-sized plane throws before any work', () => {
  const aov = makeAov(4, 4);
  const broken = { ...aov, albedo: new Uint8Array(4) };
  assertThrows(() => aov1x(broken, 4), RangeError, 'albedo length');
  const brokenMask = { ...aov, mask: new Uint16Array(3) };
  assertThrows(() => aov1x(brokenMask, 4), RangeError, 'mask length');
  assert(aov1x(aov, 4)); // the intact image still works
});
