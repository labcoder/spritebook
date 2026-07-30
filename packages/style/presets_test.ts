import { assert, assertEquals, assertStrictEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  canonicalStyleId,
  DEFAULT_STYLE_PRESET_ID,
  PAINTERLY,
  PIXEL,
  PRESETS,
  resolveStyle,
  STYLE_ALIASES,
  styleAliasNote,
} from './presets.ts';

Deno.test('every preset is keyed by its own id', () => {
  for (const [key, preset] of Object.entries(PRESETS)) {
    assertEquals(preset.id, key, `PRESETS["${key}"] carries id "${preset.id}"`);
  }
});

Deno.test('resolveStyle with no arguments is the default preset', () => {
  assertStrictEquals(resolveStyle(), PIXEL);
  assertStrictEquals(resolveStyle(DEFAULT_STYLE_PRESET_ID, undefined), PIXEL);
});

Deno.test('an unknown style id names the ones that exist, and the retired ones', () => {
  const err = assertThrows(() => resolveStyle('pixel-24'), Error);
  assertEquals(
    err.message,
    'Unknown style "pixel-24" - available: cel-2, clean, painterly, pixel ' +
      '(retired ids that still resolve: pixel-8, pixel-8-both, pixel-8-span, pixel-8-thin)',
  );
  assertThrows(() => resolveStyle('__proto__'), Error, 'Unknown style');
  assertThrows(() => resolveStyle('constructor'), Error, 'Unknown style');
});

Deno.test('a RETIRED id resolves to its replacement instead of throwing', () => {
  // A style id is on disk: CharacterManifest.look.stylePresetId records it, so
  // every character baked before a rename carries the old string. Throwing made
  // that manifest unloadable - not hypothetical, `lineless-princess` has
  // carried `pixel-8-both` since the outline spike's presets were removed.
  for (const old of Object.keys(STYLE_ALIASES)) {
    assertStrictEquals(resolveStyle(old), PIXEL, `${old} resolves`);
    assertEquals(canonicalStyleId(old), 'pixel');
  }
  // overrides still apply through the hop, and the id records where it LANDED
  const refined = resolveStyle('pixel-8', {
    quantize: { palette: 'adaptive', maxColors: 4, space: 'oklab', dither: { kind: 'none' } },
  });
  assertEquals(refined.id, 'pixel', 'the manifest self-heals to the live id on write-back');
  assertEquals(refined.quantize?.maxColors, 4);
});

Deno.test('a retired id earns a warning that names the replacement', () => {
  const note = styleAliasNote('pixel-8');
  assert(note, 'a retired id has a note');
  assert(note.includes('"pixel-8"') && note.includes('"pixel"'), note);
  assert(
    note.includes('not byte-identical'),
    `it must not imply the look is unchanged - 8 colours became 16: ${note}`,
  );
  assertEquals(styleAliasNote('pixel'), undefined, 'a live id has nothing to say');
  assertEquals(styleAliasNote('nonsense'), undefined, 'and neither has an unknown one');
  assertEquals(
    canonicalStyleId('nonsense'),
    'nonsense',
    'unknown ids pass through to resolveStyle',
  );
});

Deno.test('every alias points at a preset that actually exists', () => {
  // an alias to a typo would turn a helpful redirect into a worse error
  for (const [from, to] of Object.entries(STYLE_ALIASES)) {
    assertEquals(Object.hasOwn(PRESETS, to), true, `${from} -> ${to}, which must be live`);
    assertEquals(Object.hasOwn(PRESETS, from), false, `${from} must not also be a live preset`);
  }
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
  const stripped = resolveStyle('pixel', { quantize: undefined });
  assertEquals(stripped.quantize, PIXEL.quantize, 'quantize survives the attempt');
});

Deno.test('the error names the preset the overrides were applied to', () => {
  assertThrows(
    () => resolveStyle('cel-2', { passes: ['normal'] }),
    Error,
    'StylePreset "cel-2" with overrides',
  );
});
