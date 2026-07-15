/**
 * Encode a stripped AOV plane to PNG bytes. Each AOV declares how it encodes
 * (contracts.ts): lit/albedo/normal are 8-bit RGBA verbatim (the lit bytes are
 * already display-ready sRGB — no re-encode); depth is r32float mapped to 16-bit
 * gray; mask is the r32uint object id written as 16-bit gray. fast-png is pure
 * JS/WASM and runs in Deno.
 */
import { encode as encodePng } from 'fast-png';
import type { AovTarget } from './contracts.ts';

export function encodeAov(
  plane: Uint8Array,
  width: number,
  height: number,
  encode: AovTarget['encode'],
): Uint8Array {
  switch (encode) {
    case 'rgba8':
      return encodePng({ width, height, data: plane.slice() });
    case 'gray16': {
      const f = new Float32Array(plane.buffer, plane.byteOffset, width * height);
      const g = new Uint16Array(width * height);
      for (let i = 0; i < g.length; i++) {
        g[i] = Math.min(65535, Math.max(0, Math.round(f[i] * 65535)));
      }
      return encodePng({ width, height, data: g, channels: 1, depth: 16 });
    }
    case 'u32': {
      const u = new Uint32Array(plane.buffer, plane.byteOffset, width * height);
      const g = new Uint16Array(width * height);
      for (let i = 0; i < g.length; i++) g[i] = Math.min(65535, u[i]);
      return encodePng({ width, height, data: g, channels: 1, depth: 16 });
    }
  }
}
