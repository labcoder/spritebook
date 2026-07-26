import { assertEquals, assertStrictEquals, assertThrows } from 'jsr:@std/assert@1';
import { CAMERA_PRESETS, DEFAULT_CAMERA_PRESET_ID, resolveCamera, STANDARD_30 } from './presets.ts';

Deno.test('every preset is keyed by its own id', () => {
  for (const [key, preset] of Object.entries(CAMERA_PRESETS)) {
    assertEquals(preset.id, key, `CAMERA_PRESETS["${key}"] carries id "${preset.id}"`);
  }
});

Deno.test('the detents are the PRD elevation slider, 15 / 26.565 / 30 / 35.264', () => {
  const byElevation = Object.values(CAMERA_PRESETS)
    .map((p) => p.elevationDeg)
    .sort((a, b) => a - b);
  assertEquals(byElevation, [15, 26.565, 30, 35.264]);
  // 2:1 is atan(0.5) and isometric is atan(1/sqrt(2)) — the names are claims
  // about projection geometry, so they have to be the real angles
  assertEquals(
    CAMERA_PRESETS['two-to-one'].elevationDeg,
    Number((Math.atan(0.5) * 180 / Math.PI).toFixed(3)),
  );
  assertEquals(
    CAMERA_PRESETS['isometric'].elevationDeg,
    Number((Math.atan(1 / Math.SQRT2) * 180 / Math.PI).toFixed(3)),
  );
});

Deno.test('standard-30 holds the values the bake flags default to', () => {
  // The CLI's flag defaults and this preset are two spellings of one camera; a
  // matching cross-check lives in packages/cli/mod_test.ts, which is the side
  // that can drift. Here we pin the numbers themselves so a change to either
  // has to be deliberate on both.
  assertEquals(STANDARD_30, {
    id: 'standard-30',
    elevationDeg: 30,
    directions: 8,
    yawOffsetDeg: 0,
    pixelsPerMeter: 32,
    cellPx: { w: 64, h: 64 },
    paddingPx: 6,
    pivot: 'feet-baseline',
    orthographic: true,
  });
  assertEquals(DEFAULT_CAMERA_PRESET_ID, 'standard-30');
});

Deno.test('resolveCamera with no arguments is the default preset', () => {
  assertStrictEquals(resolveCamera(), STANDARD_30);
  assertStrictEquals(resolveCamera(DEFAULT_CAMERA_PRESET_ID, undefined), STANDARD_30);
});

Deno.test('an unknown preset id names the ones that exist', () => {
  const err = assertThrows(() => resolveCamera('topdown30x8'), Error);
  assertEquals(
    err.message,
    'Unknown camera preset "topdown30x8" - available: isometric, low-15, standard-30, two-to-one',
  );
});

Deno.test('a prototype-chain id is unknown, not a function to spread', () => {
  // `--style __proto__` was the same trap in the CLI: a bare index finds
  // Object.prototype.constructor and dies later as a confusing TypeError
  assertThrows(() => resolveCamera('constructor'), Error, 'Unknown camera preset');
  assertThrows(() => resolveCamera('__proto__'), Error, 'Unknown camera preset');
});

Deno.test('overrides refine a preset and keep its id', () => {
  const cam = resolveCamera('isometric', { directions: 16, cellPx: { w: 128, h: 128 } });
  assertEquals(cam.id, 'isometric', 'the id records where the framing came from');
  assertEquals(cam.elevationDeg, 35.264, 'untouched fields come from the preset');
  assertEquals(cam.directions, 16);
  assertEquals(cam.cellPx, { w: 128, h: 128 });
  assertEquals(CAMERA_PRESETS['isometric'].directions, 8, 'the table itself is not mutated');
});

Deno.test('an explicit undefined override means "not overridden", not "unset"', () => {
  // bakeSpecFromFlags builds this object from flags that may be absent, so
  // every key can legitimately arrive undefined; spreading those through would
  // erase required fields and fail validation with a baffling message
  const cam = resolveCamera('low-15', { directions: undefined, paddingPx: undefined });
  assertEquals(cam, CAMERA_PRESETS['low-15']);
});

Deno.test('an override that makes the camera illegal is refused', () => {
  // The preset is valid and each override is a plausible number; only the
  // COMBINATION is illegal, which is why validating the merged result matters.
  assertThrows(
    () => resolveCamera('standard-30', { elevationDeg: 90 }),
    Error,
    'CameraPreset "standard-30" with overrides',
  );
  assertThrows(() => resolveCamera('standard-30', { directions: 5 as 4 }), Error);
  assertThrows(() => resolveCamera('standard-30', { pixelsPerMeter: 0 }), Error);
  assertThrows(() => resolveCamera('standard-30', { cellPx: { w: 64, h: 0 } }), Error);
});
