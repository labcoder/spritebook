import { assert, assertAlmostEquals, assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { srgbToHex, srgbToLab } from './oklab.ts';
import {
  buildAdaptivePalette,
  hysteresis,
  nearestIndex,
  nearestWithDist,
  paletteFromHex,
} from './palette.ts';
import type { Lab, Palette } from './contracts.ts';

/** Pool a list of sRGB colors into the K*3 OKLab Float32Array the builder wants. */
function pool(colors: readonly (readonly [number, number, number])[]): Float32Array {
  const out = new Float32Array(colors.length * 3);
  for (let i = 0; i < colors.length; i++) {
    const [L, a, b] = srgbToLab(colors[i][0], colors[i][1], colors[i][2]);
    out[i * 3] = L;
    out[i * 3 + 1] = a;
    out[i * 3 + 2] = b;
  }
  return out;
}

function paletteHexSet(p: Palette): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < p.size; i++) {
    s.add(srgbToHex(p.srgb[i * 3], p.srgb[i * 3 + 1], p.srgb[i * 3 + 2]));
  }
  return s;
}

const SIX: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [0, 255, 255],
  [255, 0, 255],
];

Deno.test('buildAdaptivePalette: deterministic, byte-identical across two runs', () => {
  const colors: [number, number, number][] = [];
  for (let i = 0; i < 200; i++) {
    colors.push([(i * 53) % 256, (i * 97) % 256, (i * 29) % 256]);
  }
  const pooled = pool(colors);
  const a = buildAdaptivePalette(pooled, 8);
  const b = buildAdaptivePalette(pooled, 8);
  assertEquals(a.size, b.size);
  assertEquals(a.srgb, b.srgb); // Uint8Array compared element-wise
  assertEquals(a.lab, b.lab); // Float32Array compared element-wise
});

Deno.test('buildAdaptivePalette: size never exceeds maxColors', () => {
  const colors: [number, number, number][] = [];
  for (let i = 0; i < 200; i++) {
    colors.push([(i * 53) % 256, (i * 97) % 256, (i * 29) % 256]);
  }
  const p = buildAdaptivePalette(pool(colors), 16);
  assert(p.size <= 16, `size ${p.size} exceeded maxColors`);
  assert(p.size > 1, 'expected more than one box for 200 varied colors');
});

Deno.test('buildAdaptivePalette: N distinct colors with maxColors=N recovers them', () => {
  const p = buildAdaptivePalette(pool(SIX), 6);
  assertEquals(p.size, 6);
  assertEquals(paletteHexSet(p), new Set(SIX.map(([r, g, b]) => srgbToHex(r, g, b))));
});

Deno.test('buildAdaptivePalette: stops early when maxColors exceeds distinct colors', () => {
  const four = SIX.slice(0, 4);
  const p = buildAdaptivePalette(pool(four), 32);
  assertEquals(p.size, 4);
  assertEquals(paletteHexSet(p), new Set(four.map(([r, g, b]) => srgbToHex(r, g, b))));
});

Deno.test('buildAdaptivePalette: empty pool -> empty palette', () => {
  const p = buildAdaptivePalette(new Float32Array(0), 8);
  assertEquals(p.size, 0);
  assertEquals(p.srgb.length, 0);
  assertEquals(p.lab.length, 0);
});

Deno.test('buildAdaptivePalette: lab stays consistent with srgb (lab[i] == srgbToLab(srgb[i]))', () => {
  const p = buildAdaptivePalette(pool(SIX), 6);
  for (let i = 0; i < p.size; i++) {
    const [L, a, b] = srgbToLab(p.srgb[i * 3], p.srgb[i * 3 + 1], p.srgb[i * 3 + 2]);
    assertAlmostEquals(p.lab[i * 3], L, 1e-6);
    assertAlmostEquals(p.lab[i * 3 + 1], a, 1e-6);
    assertAlmostEquals(p.lab[i * 3 + 2], b, 1e-6);
  }
});

Deno.test('paletteFromHex: parses #rrggbb (and bare, mixed case) to correct bytes', () => {
  const p = paletteFromHex(['#FF0000', '00ff00', '#0000Ff']);
  assertEquals(p.size, 3);
  assertEquals(Array.from(p.srgb), [255, 0, 0, 0, 255, 0, 0, 0, 255]);
  // lab is precomputed from the parsed bytes.
  const [L, a, b] = srgbToLab(255, 0, 0);
  assertAlmostEquals(p.lab[0], L, 1e-6);
  assertAlmostEquals(p.lab[1], a, 1e-6);
  assertAlmostEquals(p.lab[2], b, 1e-6);
});

Deno.test('paletteFromHex: rejects malformed colors', () => {
  assertThrows(() => paletteFromHex(['#ff00']), Error, 'invalid');
  assertThrows(() => paletteFromHex(['#gggggg']), Error, 'invalid');
  assertThrows(() => paletteFromHex(['red']), Error, 'invalid');
});

Deno.test('nearestIndex / nearestWithDist: exact palette color returns its own index at ~0 distance', () => {
  const p = paletteFromHex(['#ff0000', '#00ff00', '#0000ff']);
  const cases: [Lab, number][] = [
    [srgbToLab(255, 0, 0), 0],
    [srgbToLab(0, 255, 0), 1],
    [srgbToLab(0, 0, 255), 2],
  ];
  for (const [lab, want] of cases) {
    assertEquals(nearestIndex(p, lab), want);
    const { index, dist } = nearestWithDist(p, lab);
    assertEquals(index, want);
    assert(dist < 1e-6, `expected ~0 distance, got ${dist}`);
  }
});

Deno.test('nearestWithDist: ties resolve to the lowest index; empty palette -> -1', () => {
  const dup = paletteFromHex(['#404040', '#404040', '#ff0000']);
  assertEquals(nearestIndex(dup, srgbToLab(64, 64, 64)), 0); // tie -> lowest index

  const empty = buildAdaptivePalette(new Float32Array(0), 4);
  const { index, dist } = nearestWithDist(empty, srgbToLab(10, 20, 30));
  assertEquals(index, -1);
  assertEquals(dist, Infinity);
});

Deno.test('hysteresis: keeps prev unless the candidate improves by more than eps', () => {
  // Values are exact binary fractions so the boundary comparison is unambiguous.
  // No history -> take the candidate.
  assertEquals(hysteresis(-1, 5, Infinity, 0.3, 0.02), 5);
  // Improvement (0.125) < eps (0.25) -> keep prev (kills single-pixel oscillation).
  assertEquals(hysteresis(2, 5, 0.5, 0.375, 0.25), 2);
  // Improvement (0.25) exactly eps (0.25) -> still keep prev (strict >).
  assertEquals(hysteresis(2, 5, 0.5, 0.25, 0.25), 2);
  // Improvement (0.25) > eps (0.2) -> switch to candidate.
  assertEquals(hysteresis(2, 5, 0.5, 0.25, 0.2), 5);
  // Equal distance with eps 0 -> keep prev (no strict improvement).
  assertEquals(hysteresis(2, 5, 1.0, 1.0, 0), 2);
  // Candidate == prev is a no-op.
  assertEquals(hysteresis(3, 3, 0.5, 0.5, 0.02), 3);
});
