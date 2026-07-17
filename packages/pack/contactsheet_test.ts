import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { buildContactSheet } from './contactsheet.ts';
import { frameIdKey } from './contracts.ts';

function cell(r: number, g: number, b: number, w = 8, h = 8): Uint8Array {
  const c = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    c[p * 4] = r;
    c[p * 4 + 1] = g;
    c[p * 4 + 2] = b;
    c[p * 4 + 3] = 255;
  }
  return c;
}

function cells(): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  m.set(frameIdKey({ clipId: 'idle', direction: 0, frame: 0 }), cell(200, 40, 40));
  m.set(frameIdKey({ clipId: 'idle', direction: 1, frame: 0 }), cell(40, 200, 40));
  m.set(frameIdKey({ clipId: 'idle', direction: 0, frame: 1 }), cell(40, 40, 200));
  m.set(frameIdKey({ clipId: 'idle', direction: 1, frame: 1 }), cell(200, 200, 40));
  return m;
}

const OPTS = { clipId: 'idle', directions: 2, frames: 2, cellW: 8, cellH: 8, fps: 8 };

Deno.test('contact sheet: a valid animated GIF with directions side by side', () => {
  const gif = buildContactSheet(cells(), OPTS);
  // GIF89a magic + logical screen descriptor (LE16 dims at bytes 6..9)
  assertEquals(String.fromCharCode(...gif.subarray(0, 6)), 'GIF89a');
  assertEquals(gif[6] | (gif[7] << 8), 16, 'width = directions * cellW');
  assertEquals(gif[8] | (gif[9] << 8), 8, 'height = cellH');
  assert(gif.length > 100, 'two frames of payload');
});

Deno.test('contact sheet: deterministic bytes; missing cell throws', () => {
  const a = buildContactSheet(cells(), OPTS);
  const b = buildContactSheet(cells(), OPTS);
  assertEquals(a, b, 'same cells -> identical GIF bytes');
  const partial = cells();
  partial.delete(frameIdKey({ clipId: 'idle', direction: 1, frame: 1 }));
  assertThrows(() => buildContactSheet(partial, OPTS), Error, 'missing cell');
});
