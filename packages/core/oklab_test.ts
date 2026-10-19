import { test } from 'node:test';
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import {
  labToHex,
  linearToOklab,
  linearToSrgb,
  oklabToSrgb,
  srgbToHex,
  srgbToLab,
  srgbToLinear,
} from './dist/oklab.js';

test('srgbToLinear: EOTF anchors and monotonicity', () => {
  assertEquals(srgbToLinear(0), 0);
  assertEquals(srgbToLinear(255), 1);
  // Low codes take the linear (/12.92) branch.
  assertAlmostEquals(srgbToLinear(10), (10 / 255) / 12.92, 1e-12);
  let prev = -1;
  for (let c = 0; c <= 255; c++) {
    const v = srgbToLinear(c);
    assert(v > prev, `srgbToLinear must be strictly increasing at c=${c}`);
    prev = v;
  }
});

test('linearToSrgb: inverse EOTF anchors, clamping, exact code round-trip', () => {
  assertEquals(linearToSrgb(0), 0);
  assertEquals(linearToSrgb(1), 255);
  // Out-of-range linear values clamp, and never produce NaN on negatives.
  assertEquals(linearToSrgb(-0.02), 0);
  assertEquals(linearToSrgb(1.5), 255);
  // linearToSrgb(srgbToLinear(c)) === c for every 8-bit code.
  for (let c = 0; c <= 255; c++) {
    assertEquals(linearToSrgb(srgbToLinear(c)), c, `code round-trip failed at c=${c}`);
  }
});

test('srgbToLab: known OKLab anchors (white, black, mid-grey)', () => {
  const white = srgbToLab(255, 255, 255);
  assertAlmostEquals(white[0], 1, 1e-6); // L ~= 1
  assertAlmostEquals(white[1], 0, 1e-6); // a ~= 0
  assertAlmostEquals(white[2], 0, 1e-6); // b ~= 0

  const black = srgbToLab(0, 0, 0);
  assertEquals(black[0], 0);
  assertEquals(black[1], 0);
  assertEquals(black[2], 0);

  const grey = srgbToLab(128, 128, 128);
  assert(grey[0] > 0 && grey[0] < 1, 'mid-grey L in (0,1)');
  assertAlmostEquals(grey[1], 0, 1e-6); // achromatic -> a ~= 0
  assertAlmostEquals(grey[2], 0, 1e-6); // achromatic -> b ~= 0
});

test('linearToOklab: matches srgbToLab composed with the EOTF', () => {
  const viaLinear = linearToOklab(srgbToLinear(64), srgbToLinear(160), srgbToLinear(200));
  const viaBytes = srgbToLab(64, 160, 200);
  for (let i = 0; i < 3; i++) assertAlmostEquals(viaLinear[i], viaBytes[i], 1e-12);
});

test('srgbToLab: L is strictly monotonic across the grey ramp', () => {
  let prev = -1;
  for (let c = 0; c <= 255; c++) {
    const L = srgbToLab(c, c, c)[0];
    assert(L > prev, `L must increase with grey level at c=${c}`);
    prev = L;
  }
});

test('round-trip: srgbToLab -> oklabToSrgb within +/-1 over a full sweep', () => {
  let maxErr = 0;
  for (let r = 0; r <= 255; r += 17) {
    for (let g = 0; g <= 255; g += 17) {
      for (let b = 0; b <= 255; b += 17) {
        const [rr, gg, bb] = oklabToSrgb(srgbToLab(r, g, b));
        maxErr = Math.max(maxErr, Math.abs(rr - r), Math.abs(gg - g), Math.abs(bb - b));
        assert(
          Math.abs(rr - r) <= 1 && Math.abs(gg - g) <= 1 && Math.abs(bb - b) <= 1,
          `round-trip off by >1 at (${r},${g},${b}) -> (${rr},${gg},${bb})`,
        );
      }
    }
  }
  // In practice the sweep round-trips exactly; the <=1 tolerance is headroom.
  assertEquals(maxErr, 0);
});

test('oklabToSrgb: clamps out-of-gamut OKLab into valid bytes', () => {
  const [r, g, b] = oklabToSrgb([1, 0.5, -0.3]); // heavily out of the sRGB gamut
  for (const v of [r, g, b]) {
    assert(Number.isInteger(v) && v >= 0 && v <= 255, `channel ${v} not a valid byte`);
  }
});

test('srgbToHex / labToHex: formatting and round-trip', () => {
  assertEquals(srgbToHex(255, 0, 0), '#ff0000');
  assertEquals(srgbToHex(0, 128, 255), '#0080ff');
  assertEquals(srgbToHex(18, 52, 86), '#123456');
  // Out-of-range inputs are clamped before formatting.
  assertEquals(srgbToHex(-5, 300, 128), '#00ff80');
  // labToHex composes oklabToSrgb; a byte color survives the lab round-trip.
  assertEquals(labToHex(srgbToLab(18, 52, 86)), '#123456');
});
