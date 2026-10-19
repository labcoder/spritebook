import { test } from 'node:test';
import { assertEquals, assertThrows } from '@std/assert';
import { decode } from 'fast-png';
import { encode } from './dist/codec.js';

test('native PNG files decode independently with valid CRCs and intact 8/16-bit channels', () => {
  for (const channels of [1, 2, 3, 4]) {
    for (const depth of [8, 16] as const) {
      const ArrayType = depth === 8 ? Uint8Array : Uint16Array;
      // A view into a larger buffer catches offset, length and in-place byte-swap mistakes.
      const backing = new ArrayType(3 * 2 * channels + 4).fill(173);
      const data = backing.subarray(2, -2);
      for (let i = 0; i < data.length; i++) {
        data[i] = (i * 1973 + 131) % (depth === 8 ? 256 : 65536);
      }
      const before = backing.slice();
      const png = encode({ width: 3, height: 2, channels, depth, data });
      const image = decode(png, { checkCrc: true });
      assertEquals([image.width, image.height, image.channels, image.depth], [
        3,
        2,
        channels,
        depth,
      ]);
      assertEquals(Array.from(image.data), Array.from(data));
      assertEquals(backing, before, 'encoding must not mutate caller-owned pixels');
    }
  }
});

test('native PNG refuses inconsistent dimensions, depth and unsupported options', () => {
  assertThrows(() => encode({ width: 2, height: 1, data: new Uint8Array(4) }));
  assertThrows(() => encode({ width: 1, height: 1, depth: 16, data: new Uint8Array(4) }));
  assertThrows(() =>
    encode({ width: 1, height: 1, data: new Uint8Array(4) }, { zlib: { level: 1 } })
  );
});
