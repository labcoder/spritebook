import { assert, assertEquals } from 'jsr:@std/assert@1';
import { coverageFromLit, readAov } from './aovio.ts';

const FRAMES = new URL('./fixtures/aov/frames/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

Deno.test('readAov decodes the committed Sx AOV planes', async () => {
  const aov = await readAov(FRAMES, 0, 0);
  // 1x cell 64 * S 4 = 256
  assertEquals([aov.width, aov.height], [256, 256]);
  assertEquals(aov.lit.length, 256 * 256 * 4, 'lit is rgba8');
  assertEquals(aov.albedo.length, 256 * 256 * 4);
  assertEquals(aov.normal.length, 256 * 256 * 4);
  assertEquals(aov.depth.length, 256 * 256, 'depth is gray16');
  assertEquals(aov.mask.length, 256 * 256, 'mask is gray16');
  assert(aov.depth instanceof Uint16Array && aov.mask instanceof Uint16Array);
  // the character is present: some opaque lit pixels and some object-id in the mask
  let opaque = 0, masked = 0;
  for (let p = 0; p < 256 * 256; p++) {
    if (aov.lit[p * 4 + 3] > 0) opaque++;
    if (aov.mask[p] > 0) masked++;
  }
  assert(opaque > 100 && masked > 100, `character present (opaque=${opaque}, masked=${masked})`);
});

Deno.test('coverageFromLit extracts the alpha plane', () => {
  const lit = new Uint8Array([0, 0, 0, 0, 9, 9, 9, 200]);
  assertEquals([...coverageFromLit(lit, 2, 1)], [0, 200]);
});
