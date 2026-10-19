// Qualified native PNG encoding; independent decoding stays in fast-png.
import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { endianness } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import type { ImageData, PngEncoderOptions } from 'fast-png';
export { decode } from 'fast-png';

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  out.write(type, 4, 4, 'ascii');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}

export function encode(png: ImageData, options?: PngEncoderOptions): Uint8Array {
  const { width, height, data, channels = 4, depth = 8 } = png;
  assert(
    !options || Object.keys(options).length === 0,
    'PNG encoder accepts default options only',
  );
  assert([1, 2, 3, 4].includes(channels), 'raw grayscale/RGB(A) required');
  assert([8, 16].includes(depth) && data.BYTES_PER_ELEMENT === depth / 8);
  assert(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0);
  assert.equal(data.length, width * height * channels);
  const rowBytes = width * channels * (depth / 8);
  let bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (depth === 16 && endianness() === 'LE') bytes = Buffer.from(bytes).swap16();
  const scanlines = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    bytes.copy(scanlines, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = [0, 0, 4, 2, 6][channels];
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 3 })),
    chunk('IEND', new Uint8Array()),
  ]));
}
