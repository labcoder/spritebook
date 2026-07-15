import { assertEquals } from 'jsr:@std/assert@1';
import { flickerPct } from './flicker.ts';

Deno.test('flickerPct is 0 for identical frames and <2 frames', () => {
  const f = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
  assertEquals(flickerPct([f], 2, 1), 0);
  assertEquals(flickerPct([f, f.slice(), f.slice()], 2, 1), 0);
});

Deno.test('flickerPct averages changed-pixel fraction over transitions', () => {
  // 2 pixels; frame b changes exactly 1 of 2 -> 50%
  const a = new Uint8Array([1, 1, 1, 255, 2, 2, 2, 255]);
  const b = new Uint8Array([1, 1, 1, 255, 9, 9, 9, 255]);
  assertEquals(flickerPct([a, b], 2, 1), 50);
  // a->b (50%), b->b (0%): mean 25%
  assertEquals(flickerPct([a, b, b.slice()], 2, 1), 25);
});
