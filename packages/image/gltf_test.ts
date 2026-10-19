import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { decode } from 'fast-png';
import { encode, getPixels, savePixels } from './dist/mod.js';

test('glTF pixels preserve PNG channels, 16-bit samples and indexed transparency', async () => {
  const gray = await getPixels(
    encode({ width: 2, height: 1, channels: 1, depth: 16, data: new Uint16Array([65280, 255]) }),
    'image/png',
  );
  assert.deepEqual(gray.shape, [2, 1, 4]);
  assert.deepEqual([...gray.data], [255, 255, 255, 255, 0, 0, 0, 255]);
  // Committed fixture generated with Pillow, independently of the Node codec.
  const palette = await getPixels(
    await readFile(new URL('./fixtures/palette.png', import.meta.url)),
    'image/png',
  );
  assert.deepEqual([...palette.data], [
    0,
    0,
    0,
    0,
    17,
    34,
    51,
    255,
    200,
    100,
    50,
    128,
    255,
    255,
    255,
    255,
  ]);
});

test('glTF image writes honor ndarray strides and JPEG decodes to opaque RGBA', async () => {
  const original = encode({
    width: 2,
    height: 1,
    data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
  });
  const pixels = await getPixels(original, 'image/png');
  const saved = decode(await savePixels(pixels.transpose(1, 0, 2), 'image/png'), {
    checkCrc: true,
  });
  assert.deepEqual([saved.width, saved.height], [1, 2]);
  assert.deepEqual([...saved.data], [...pixels.data]);
  const red = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < red.length; i += 4) red.set([255, 0, 0, 255], i);
  const jpg = await getPixels(
    jpeg.encode({ width: 8, height: 8, data: red }, 95).data,
    'image/jpeg',
  );
  assert(jpg.get(4, 4, 0) >= 253 && jpg.get(4, 4, 1) <= 2 && jpg.get(4, 4, 2) <= 2);
  assert.equal(jpg.get(4, 4, 3), 255);
});

test('glTF pixel IO rejects non-byte sources, corrupt PNGs and unsupported encodings', async () => {
  await assert.rejects(
    getPixels('https://example.invalid/image.png' as never, 'image/png'),
    /must be bytes/,
  );
  await assert.rejects(getPixels(new Uint8Array([1, 2, 3]), 'image/png'));
  await assert.rejects(getPixels(new Uint8Array(), 'image/webp'), /Unsupported image type/);
});
