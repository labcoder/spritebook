/**
 * Encode a stripped AOV plane to PNG bytes. Each AOV declares how it encodes
 * (contracts.ts): lit/albedo/normal are 8-bit RGBA verbatim (the lit bytes are
 * already display-ready sRGB — no re-encode); depth is r32float mapped to 16-bit
 * gray; mask is the r32uint coverage mapped to 16-bit gray FULL SCALE.
 */
import { encode as encodePng } from './codec.ts';
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
    // Coverage. The shader writes a constant 1 where a fragment survived, and
    // this used to store that 1 verbatim in a 16-bit gray PNG — a correct file
    // that every viewer renders as a black rectangle, because 1/65535 is 0.002%
    // brightness. It read as an empty atlas in the P3 exit measurement and was
    // reported as a blocker; the data had been right the whole time.
    //
    // So coverage is encoded across the range it is stored in. It is a BOOLEAN
    // today (contracts.ts: multi-primitive characters are indistinguishable
    // here), which is why this is a threshold and not a scale — and why it is
    // idempotent, so decoding a page and re-encoding it, as the mirror path
    // does, cannot drift. Every reader in the tree tests `=== 0` or truthiness,
    // never `=== 1`; a per-primitive id would replace this encoding outright.
    case 'u32': {
      const u = new Uint32Array(plane.buffer, plane.byteOffset, width * height);
      const g = new Uint16Array(width * height);
      for (let i = 0; i < g.length; i++) g[i] = u[i] === 0 ? 0 : 65535;
      return encodePng({ width, height, data: g, channels: 1, depth: 16 });
    }
  }
}
