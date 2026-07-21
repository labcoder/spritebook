/**
 * The npz reader is parsed bytes, so it is tested against bytes: `_fixtures.ts`
 * encodes npy headers and ZIP records independently (numpy's own layout,
 * 64-byte header padding and all), and these tests assert the reader recovers
 * exactly what was written — every supported dtype, both compression methods,
 * both npy header versions — and that every malformed shape fails with a
 * message naming what was wrong rather than a stack trace inside a byte loop.
 */
import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { encodeNpy, encodeNpz, encodeZip, type FixtureDType } from './_fixtures.ts';
import { parseNpy, readNpz } from './npz.ts';

async function expectThrows(fn: () => Promise<unknown>, ...needles: string[]): Promise<void> {
  let message = '';
  try {
    await fn();
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message !== '', `expected a throw mentioning ${needles.join(' + ')}`);
  for (const n of needles) {
    assert(message.includes(n), `expected "${n}" in error message, got: ${message}`);
  }
}

Deno.test('npy round-trips every supported dtype', () => {
  const cases: [FixtureDType, number[]][] = [
    ['uint8', [0, 1, 254, 255]],
    ['uint16', [0, 7, 65535, 300]],
    ['uint32', [0, 1, 4294967295, 12345]],
    ['int32', [-2147483648, -1, 0, 2147483647]],
    ['float32', [0, -1.5, 0.25, 3.5]],
  ];
  for (const [dtype, values] of cases) {
    const npy = parseNpy(encodeNpy(dtype, [2, 2], values), dtype);
    assertEquals(npy.dtype, dtype);
    assertEquals(npy.shape, [2, 2]);
    assertEquals([...npy.data], values);
  }
});

Deno.test('npy handles 1-D shapes and the v2 header', () => {
  const flat = parseNpy(encodeNpy('float32', [3], [1, 2, 3]), 'flat');
  assertEquals(flat.shape, [3]);
  assertEquals([...flat.data], [1, 2, 3]);

  const v2 = parseNpy(encodeNpy('int32', [2, 3], [1, 2, 3, 4, 5, 6], { version: 2 }), 'v2');
  assertEquals(v2.shape, [2, 3]);
  assertEquals([...v2.data], [1, 2, 3, 4, 5, 6]);
});

Deno.test('npy rejects Fortran order, big-endian and unsupported dtypes', () => {
  assertThrows(
    () => parseNpy(encodeNpy('float32', [2, 2], [1, 2, 3, 4], { fortranOrder: true }), 'f'),
    Error,
    'Fortran-order',
  );
  assertThrows(
    () => parseNpy(encodeNpy('float32', [2], [1, 2], { descr: '>f4' }), 'be'),
    Error,
    'big-endian',
  );
  assertThrows(
    () => parseNpy(encodeNpy('float32', [2], [1, 2], { descr: '<f8' }), 'f8'),
    Error,
    "unsupported dtype '<f8'",
  );
});

Deno.test('npy rejects bad magic and truncated data', () => {
  const good = encodeNpy('float32', [2, 2], [1, 2, 3, 4]);
  const bad = good.slice();
  bad[1] = 0x41;
  assertThrows(() => parseNpy(bad, 'magic'), Error, 'not an npy file');
  assertThrows(() => parseNpy(good.subarray(0, good.length - 5), 'short'), Error, 'truncated data');
  assertThrows(() => parseNpy(good.subarray(0, 4), 'tiny'), Error, 'truncated npy');
});

Deno.test('npz round-trips stored and deflated members', async () => {
  const joints = [0, 1, 2, 3, 4, 5];
  const weights = [1, 0, 0.5, 0.5, 0.25, 0.75];
  for (const deflate of [false, true]) {
    const bytes = await encodeNpz([
      { name: 'joints', dtype: 'uint16', shape: [3, 2], data: joints, deflate },
      { name: 'weights', dtype: 'float32', shape: [3, 2], data: weights, deflate },
    ]);
    const npz = await readNpz(bytes, `rig.npz(deflate=${deflate})`);
    assertEquals([...npz.keys()].sort(), ['joints', 'weights']);
    assertEquals(npz.get('joints')!.shape, [3, 2]);
    assertEquals([...npz.get('joints')!.data], joints);
    assertEquals([...npz.get('weights')!.data], weights);
  }
});

Deno.test('npz names members by stripping .npy', async () => {
  const bytes = await encodeZip([
    { name: 'predict_skin.npy', data: encodeNpy('float32', [1], [1]) },
  ]);
  const npz = await readNpz(bytes, 'rig.npz');
  assert(npz.has('predict_skin'));
});

Deno.test('npz fails actionably on a non-zip and on a corrupt member', async () => {
  await expectThrows(
    () => readNpz(new TextEncoder().encode('this is not a zip archive at all'), 'rig.npz'),
    'rig.npz',
    'not a zip archive',
  );

  // an npy member whose declared shape outruns its bytes
  const short = encodeNpy('float32', [4, 4], [1, 2, 3, 4]);
  const bytes = await encodeZip([{ name: 'weights.npy', data: short }]);
  await expectThrows(() => readNpz(bytes, 'rig.npz'), 'rig.npz[weights]', 'truncated data');
});

Deno.test('npz rejects an unsupported compression method by number', async () => {
  const bytes = await encodeZip([{ name: 'weights.npy', data: encodeNpy('float32', [1], [1]) }]);
  const view = new DataView(bytes.buffer);
  const cdOffset = view.getUint32(bytes.length - 22 + 16, true);
  view.setUint16(8, 12, true); // local header method
  view.setUint16(cdOffset + 10, 12, true); // central directory method
  await expectThrows(() => readNpz(bytes, 'rig.npz'), 'weights.npy', 'method 12');
});
