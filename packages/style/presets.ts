/**
 * The three P2-T2 style presets as schema-validated fixtures. All use
 * superSample 4 so they consume the committed S=4 AOV fixtures directly.
 *
 * SCOPE NOTE: the render module emits continuous Lambert `lit` and the style
 * stage has no light direction, so a true cel N.L ramp (StylePreset.ramp) cannot
 * be computed here. T2 realizes the preset MODES as quantization variants — cel =
 * small palette, pixel = small palette + ordered dither, painterly = large
 * palette + area-average downsample. Ramp-based cel shading is a future
 * render-side mode; `ramp` is carried for schema completeness but not applied.
 */
import { type StyleOverrides, type StylePreset, StylePresetSchema } from '@spritebook/schema';
import { parseWith } from '@spritebook/schema';

const ALL_PASSES = ['lit', 'albedo', 'normal', 'depth', 'mask'] as const;

/** cel: few flat tones (small palette), crisp 1px outline, no dither. */
export const CEL_2: StylePreset = parseWith(StylePresetSchema, {
  id: 'cel-2',
  mode: 'cel',
  ramp: { stops: 2, rimStrength: 0.3 },
  quantize: {
    palette: 'adaptive',
    maxColors: 6,
    space: 'oklab',
    dither: { kind: 'none' },
  },
  outline: {
    widthPx: 1,
    normalThreshold: 0.5,
    depthThresholdScaled: 0.15,
    colorFrom: 'palette-dark',
  },
  temporal: { superSample: 4, clusterVote: true, paletteHysteresisEps: 0.02, texelSnap: true },
  passes: [...ALL_PASSES],
  alpha: { mode: '1bit', cutoff: 0.5, bleedPx: 2 },
}, 'StylePreset cel-2');

/** pixel: small adaptive palette + ordered dither + 1-bit alpha (the full stack). */
export const PIXEL_8: StylePreset = parseWith(StylePresetSchema, {
  id: 'pixel-8',
  mode: 'pixel',
  quantize: {
    palette: 'adaptive',
    maxColors: 8,
    space: 'oklab',
    dither: { kind: 'ordered', matrix: 4, strength: 0.5 },
  },
  outline: {
    widthPx: 1,
    normalThreshold: 0.5,
    depthThresholdScaled: 0.15,
    colorFrom: 'palette-dark',
  },
  temporal: { superSample: 4, clusterVote: true, paletteHysteresisEps: 0.02, texelSnap: true },
  passes: [...ALL_PASSES],
  alpha: { mode: '1bit', cutoff: 0.5, bleedPx: 2 },
}, 'StylePreset pixel-8');

/** painterly: larger palette, area-average downsample, soft alpha, no hard outline. */
export const PAINTERLY: StylePreset = parseWith(StylePresetSchema, {
  id: 'painterly',
  mode: 'painterly',
  quantize: {
    palette: 'adaptive',
    maxColors: 32,
    space: 'oklab',
    dither: { kind: 'none' },
  },
  temporal: { superSample: 4, clusterVote: false, paletteHysteresisEps: 0.03, texelSnap: true },
  passes: [...ALL_PASSES],
  alpha: { mode: 'soft', bleedPx: 2 },
}, 'StylePreset painterly');

export const PRESETS: Record<string, StylePreset> = {
  'cel-2': CEL_2,
  'pixel-8': PIXEL_8,
  'painterly': PAINTERLY,
};

/** What `resolveStyle` falls back to, and what `bake --style` defaults to. */
export const DEFAULT_STYLE_PRESET_ID = 'pixel-8';

/**
 * Resolve a preset id and optional overrides into the style a bake runs with —
 * the peer of `resolveCamera` in @spritebook/core, and the half of
 * `CharacterManifest.look` that P4's Look stage edits (D-029).
 *
 * Overrides are a SHALLOW merge, so `alpha` replaces wholesale: switching a
 * painterly character to 1-bit alpha means restating `bleedPx` too. That reads
 * like a trap until you see what the alternative costs — a deep merge would let
 * `{ alpha: { mode: '1bit' } }` produce a style with no `cutoff`, which is
 * precisely the combination StylePresetSchema exists to refuse.
 *
 * Which is the other half of this function: the merged result is re-validated
 * against StylePresetSchema, superRefine and all, NOT against the base object.
 * Every cross-field rule there is reachable by a legal-looking override —
 * '1bit' without a cutoff, `passes` without 'lit' (AOV pages share the lit
 * layout, D-010), `clusterVote` without a palette (which paints a blank sprite
 * and reports flickerPct 0, a perfect stability score). A preset is valid and
 * an override is valid; only their COMBINATION can be wrong.
 */
export function resolveStyle(
  presetId: string = DEFAULT_STYLE_PRESET_ID,
  overrides?: StyleOverrides,
): StylePreset {
  // Object.hasOwn, not a bare index: `--style __proto__` would otherwise find
  // Object.prototype and die later as a confusing TypeError (m7)
  if (!Object.hasOwn(PRESETS, presetId)) {
    throw new Error(
      `Unknown style "${presetId}" - available: ${Object.keys(PRESETS).sort().join(', ')}`,
    );
  }
  const base = PRESETS[presetId];
  if (overrides === undefined) return base;
  // an explicit `undefined` means "not overridden", not "unset" — erasing a
  // required field through the spread would fail with a baffling message
  const applied: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) applied[k] = v;
  return parseWith(
    StylePresetSchema,
    { ...base, ...applied },
    `StylePreset "${presetId}" with overrides`,
  );
}
