import { test } from 'node:test';
/**
 * AOV PNG encoding — the seam where a plane becomes a file someone opens.
 *
 * `encodeAov` had no tests. That is how `atlas_mask_0.png` shipped as a black
 * rectangle for the whole of P2 and P3: the coverage shader writes a constant
 * 1, the encoder stored that 1 verbatim in a 16-bit gray PNG, and 1/65535 is
 * 0.002% brightness. The bytes were correct and the artifact was unreadable, so
 * the P3 exit measurement reported an empty mask atlas as a blocker.
 *
 * The lesson these tests encode is that "the values are right" is not the whole
 * contract for a file — it also has to be distinguishable from the failure it
 * would look like.
 */
import { assert, assertEquals } from '@std/assert';
import { decode as decodePng } from 'fast-png';
import { encodeAov } from './dist/png.js';

/** A coverage plane as the readback hands it over: u32 bytes, 1 = drawn. */
function coverage(width: number, height: number, drawn: (i: number) => boolean): Uint8Array {
  const u = new Uint32Array(width * height);
  for (let i = 0; i < u.length; i++) u[i] = drawn(i) ? 1 : 0;
  return new Uint8Array(u.buffer);
}

test('a covered mask texel encodes to full white, not to a value of 1', () => {
  const w = 4, h = 4;
  const png = encodeAov(coverage(w, h, (i) => i % 2 === 0), w, h, 'u32');
  const img = decodePng(png);
  assertEquals(img.channels, 1);
  assertEquals(img.depth, 16);

  const d = img.data as Uint16Array;
  assertEquals(d[0], 65535, 'drawn is the top of the range the file can hold');
  assertEquals(d[1], 0, 'and empty is still zero');
  // the property that matters, stated as the failure it prevents: a correct
  // mask must not be dark enough to pass for an empty one
  const max = Math.max(...d);
  assert(max > 32767, `a mask with coverage must be visibly non-black, got max ${max}`);
});

test('an all-empty mask really is black, so blank still reads as blank', () => {
  const png = encodeAov(coverage(4, 4, () => false), 4, 4, 'u32');
  const d = decodePng(png).data as Uint16Array;
  assertEquals(Math.max(...d), 0, 'nothing drawn stays nothing');
});

test('coverage encoding is idempotent, so a mirrored page cannot drift', () => {
  // pack/mirror.ts decodes a cell, flips it and re-encodes. A scale rather than
  // a threshold would multiply 65535 by 65535 on the second pass.
  const u = new Uint32Array([0, 1, 65535, 7]);
  const d = decodePng(encodeAov(new Uint8Array(u.buffer), 2, 2, 'u32')).data as Uint16Array;
  assertEquals([...d], [0, 65535, 65535, 65535], 'any coverage is the same coverage');
});

test('depth still scales, because it is a measurement and not a flag', () => {
  // the neighbouring case, pinned so the mask fix cannot be copied onto it:
  // depth carries a continuum and thresholding it would destroy the AOV
  const f = new Float32Array([0, 0.25, 0.5, 1]);
  const d = decodePng(encodeAov(new Uint8Array(f.buffer), 2, 2, 'gray16')).data as Uint16Array;
  assertEquals([...d], [0, 16384, 32768, 65535]);
});
