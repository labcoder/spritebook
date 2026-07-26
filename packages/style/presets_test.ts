import { assertEquals, assertStrictEquals, assertThrows } from 'jsr:@std/assert@1';
import { DEFAULT_STYLE_PRESET_ID, PAINTERLY, PIXEL_8, PRESETS, resolveStyle } from './presets.ts';

Deno.test('every preset is keyed by its own id', () => {
  for (const [key, preset] of Object.entries(PRESETS)) {
    assertEquals(preset.id, key, `PRESETS["${key}"] carries id "${preset.id}"`);
  }
});

Deno.test('resolveStyle with no arguments is the default preset', () => {
  assertStrictEquals(resolveStyle(), PIXEL_8);
  assertStrictEquals(resolveStyle(DEFAULT_STYLE_PRESET_ID, undefined), PIXEL_8);
});

Deno.test('an unknown style id names the ones that exist', () => {
  const err = assertThrows(() => resolveStyle('pixel-16'), Error);
  assertEquals(err.message, 'Unknown style "pixel-16" - available: cel-2, painterly, pixel-8');
  assertThrows(() => resolveStyle('__proto__'), Error, 'Unknown style');
  assertThrows(() => resolveStyle('constructor'), Error, 'Unknown style');
});

Deno.test('overrides refine a preset and keep its id', () => {
  const style = resolveStyle('painterly', {
    outline: { widthPx: 2, normalThreshold: 0.5, depthThresholdScaled: 0.15, colorFrom: '#101010' },
  });
  assertEquals(style.id, 'painterly', 'the id records where the look came from');
  assertEquals(style.outline?.widthPx, 2);
  assertEquals(style.quantize?.maxColors, 32, 'untouched fields come from the preset');
  assertEquals(PAINTERLY.outline, undefined, 'the table itself is not mutated');
});

Deno.test('an explicit undefined override means "not overridden", not "unset"', () => {
  assertEquals(resolveStyle('cel-2', { outline: undefined, ramp: undefined }), PRESETS['cel-2']);
});

Deno.test("an override that leaves '1bit' alpha without a cutoff is refused", () => {
  // The shallow-merge trap, and why the merged result is re-validated against
  // StylePresetSchema rather than the base object: painterly is 'soft', so this
  // override is the ONLY way the manifest can express 1-bit alpha, and it is
  // one field short of a legal style. Unvalidated, the cut runs against
  // `cutoff: undefined` and silhouettes come out empty.
  assertThrows(
    () => resolveStyle('painterly', { alpha: { mode: '1bit', bleedPx: 2 } }),
    Error,
    'cutoff',
  );
  // restating the field the shallow merge dropped is what makes it legal
  const ok = resolveStyle('painterly', { alpha: { mode: '1bit', cutoff: 0.5, bleedPx: 2 } });
  assertEquals(ok.alpha, { mode: '1bit', cutoff: 0.5, bleedPx: 2 });
});

Deno.test("an override that drops 'lit' from passes is refused", () => {
  // D-010: AOV pages share the lit layout, so a bake without it has no page
  // geometry to hang the others on
  assertThrows(
    () => resolveStyle('cel-2', { passes: ['albedo', 'normal'] }),
    Error,
    "must include 'lit'",
  );
});

Deno.test('overrides cannot remove a field, only replace one', () => {
  // The third cross-field rule — clusterVote without a palette paints a blank
  // sprite and reports flickerPct 0, a perfect stability score (pipeline_test
  // pins the refusal itself) — is unreachable through overrides, and this is
  // why: `undefined` is filtered out as "not overridden", so no override can
  // strip the `quantize` off a preset that has one. All three presets do.
  const stripped = resolveStyle('pixel-8', { quantize: undefined });
  assertEquals(stripped.quantize, PIXEL_8.quantize, 'quantize survives the attempt');
});

Deno.test('the error names the preset the overrides were applied to', () => {
  assertThrows(
    () => resolveStyle('cel-2', { passes: ['normal'] }),
    Error,
    'StylePreset "cel-2" with overrides',
  );
});
