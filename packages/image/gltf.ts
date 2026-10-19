import { strict as assert } from 'node:assert';
import { decode as decodePng, type DecodedPng } from 'fast-png';
import jpeg from 'jpeg-js';
import ndarray, { type NdArray } from 'ndarray';
import { encode } from './codec.ts';

/** Raw PNG samples become RGBA8 without changing the caller's backing store. */
export function rgba8(image: DecodedPng): Uint8Array {
  const { channels, depth, palette, transparency } = image;
  let data = image.data;
  if (depth < 8) {
    assert.equal(channels, 1, 'Packed PNG samples must have one channel');
    const unpacked = new Uint8Array(image.width * image.height);
    const rowBytes = Math.ceil(image.width * depth / 8);
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const bit = x * depth;
        unpacked[y * image.width + x] =
          (data[y * rowBytes + (bit >>> 3)] >>> (8 - depth - bit % 8)) & (2 ** depth - 1);
      }
    }
    data = unpacked;
  }
  const out = new Uint8Array(image.width * image.height * 4);
  const to8 = depth === 16
    ? (v: number) => v >>> 8
    : (v: number) => Math.round(v * 255 / (2 ** depth - 1));
  for (let i = 0; i < image.width * image.height; i++) {
    const src = i * channels, dst = i * 4;
    if (palette) {
      const color = palette[data[src]];
      assert(color, 'PNG palette index is out of range');
      out.set([color[0], color[1], color[2], color[3] ?? 255], dst);
    } else {
      out[dst] = to8(data[src]);
      out[dst + 1] = to8(data[src + (channels >= 3 ? 1 : 0)]);
      out[dst + 2] = to8(data[src + (channels >= 3 ? 2 : 0)]);
      out[dst + 3] = channels === 2 || channels === 4 ? to8(data[src + channels - 1]) : 255;
      if (transparency?.length && transparency.every((value, c) => value === data[src + c])) {
        out[dst + 3] = 0;
      }
    }
  }
  return out;
}

/** glTF's PNG/JPEG pixel boundary; URLs and filesystem paths are deliberately not accepted. */
export async function getPixels(input: Uint8Array, mimeType: string): Promise<NdArray<Uint8Array>> {
  assert(input instanceof Uint8Array, 'Image input must be bytes');
  let width: number, height: number, data: Uint8Array;
  if (mimeType === 'image/png') {
    const image = decodePng(input, { checkCrc: true });
    ({ width, height } = image);
    data = rgba8(image);
  } else {
    assert.equal(mimeType, 'image/jpeg', `Unsupported image type: ${mimeType}`);
    ({ width, height, data } = jpeg.decode(input, { useTArray: true, formatAsRGBA: true }));
  }
  return ndarray(data, [width, height, 4], [4, width * 4, 1]);
}

/** Material transforms may pass sliced/transposed ndarrays, so read through their strides. */
export async function savePixels(
  pixels: NdArray<Uint8Array>,
  mimeType: string,
): Promise<Uint8Array> {
  const [width, height, channels] = pixels.shape;
  assert(pixels.shape.length === 3 && width > 0 && height > 0 && [1, 2, 3, 4].includes(channels));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      data[at] = pixels.get(x, y, 0);
      data[at + 1] = pixels.get(x, y, channels >= 3 ? 1 : 0);
      data[at + 2] = pixels.get(x, y, channels >= 3 ? 2 : 0);
      data[at + 3] = channels === 2 || channels === 4 ? pixels.get(x, y, channels - 1) : 255;
    }
  }
  if (mimeType === 'image/png') return encode({ width, height, data });
  assert.equal(mimeType, 'image/jpeg', `Unsupported image type: ${mimeType}`);
  return new Uint8Array(jpeg.encode({ width, height, data }, 90).data);
}
