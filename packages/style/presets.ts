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

/**
 * pixel: adaptive palette + ordered dither + 1-bit alpha (the full stack).
 *
 * SIXTEEN colours, and the name deliberately does not say a number any more.
 * It used to be `pixel-8`, and 8 turned out to be the reason generated
 * characters looked muddy: median cut allocates by POPULATION, so on bulma the
 * skin and top (59% of covered texels) took five of the eight entries and the
 * hair and skirt shared the remainder. The colour was in the lit pass the whole
 * time — 9,895 distinct — and quantization was throwing it away.
 *
 * Measured across three subjects at matched on-screen size
 * (spikes/trellis2/COLOUR-REPORT.md):
 *
 *   bulma     8 -> olive hair, black skirt;  16 -> pink top, green hair, navy skirt
 *   mermaid   8 -> six teals and two greys, no figure visible at all
 *             16 -> skin tones appear and the body separates from the hair
 *   princess  8 -> readable;  16 -> the same, finer gradations (no second hue to find)
 *
 * So 16 is a large win on two subjects and a null on the third, never a
 * regression. Flicker on the golden fixture goes 0.273% -> 0.420%, still inside
 * the 0.55% regression guard and well inside the roadmap's 1.2% target.
 *
 * The count is not a ceiling either way: `bake --colors <n>` takes 2..256.
 */
export const PIXEL: StylePreset = parseWith(StylePresetSchema, {
  id: 'pixel',
  mode: 'pixel',
  quantize: {
    palette: 'adaptive',
    maxColors: 16,
    space: 'oklab',
    dither: { kind: 'ordered', matrix: 4, strength: 0.5 },
  },
  outline: {
    // Half a pixel, not one. The stroke is drawn at Sx (superSample 4, so 2
    // texels) and downsamples to a partial pixel — the only way to thin it at
    // small cells. At 1.0 a slim generated character was MOSTLY outline: a
    // 1 px inward stroke from both sides of a 3 px limb is 2/3 of the limb,
    // measured at 67% of bulma's body at 64 px against 41% at 0.5. Picked from
    // renders (spikes/trellis2/out/p3-exit/outline_options.png), not numbers.
    // cel-2 keeps 1.0: its look leans on the heavier line.
    widthPx: 0.5,
    normalThreshold: 0.5,
    depthThresholdScaled: 0.15,
    colorFrom: 'palette-dark',
  },
  temporal: { superSample: 4, clusterVote: true, paletteHysteresisEps: 0.02, texelSnap: true },
  passes: [...ALL_PASSES],
  alpha: { mode: '1bit', cutoff: 0.5, bleedPx: 2 },
}, 'StylePreset pixel');

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
  'pixel': PIXEL,
  'painterly': PAINTERLY,
};

/** What `resolveStyle` falls back to, and what `bake --style` defaults to. */
export const DEFAULT_STYLE_PRESET_ID = 'pixel';

/**
 * Retired preset ids and what they resolve to now.
 *
 * A style id is not an internal detail: `CharacterManifest.look.stylePresetId`
 * records it, and every character baked before a rename carries the old string
 * on disk. Without this map that manifest throws on load — which is not a
 * hypothetical. `lineless-princess` still carries `pixel-8-both`, from a set of
 * experimental presets that were removed when the outline spike ended, and it
 * has been unloadable ever since.
 *
 * Aliasing rather than keeping the old presets alive is deliberate: two entries
 * that differ only in palette size would both need maintaining, and the ids the
 * spike minted (`-both`, `-span`, `-thin`) described experiments whose answers
 * are now folded into `pixel` itself. What the user gets is the current preset
 * plus a warn that says which id moved and where, so a manifest silently baking
 * a DIFFERENT look than its id once meant is impossible.
 *
 * A retired id keeps working forever from here; this map only grows.
 */
export const STYLE_ALIASES: Record<string, string> = {
  // pixel-8 -> pixel, when 8 colours became 16 (spikes/trellis2/COLOUR-REPORT.md)
  'pixel-8': 'pixel',
  // the outline spike's experimental trio; their findings are in `pixel`'s
  // widthPx 0.5 and the optional minSpanPx
  'pixel-8-thin': 'pixel',
  'pixel-8-span': 'pixel',
  'pixel-8-both': 'pixel',
};

/**
 * The warn a retired id earns, or undefined for a live one.
 *
 * Separate from `resolveStyle` because resolution returns a style and has no
 * channel for a message; the CLI emits this next to the warns it already emits,
 * and a caller that does not care simply never asks.
 */
export function styleAliasNote(presetId: string): string | undefined {
  const to = STYLE_ALIASES[presetId];
  if (to === undefined) return undefined;
  return `style "${presetId}" no longer exists and resolved to "${to}". ` +
    `Presets are recorded in the character's look, so an id from an earlier version keeps ` +
    `working - but "${to}" is not byte-identical to what "${presetId}" used to produce. ` +
    `Check this bake before shipping it, and pass \`--style <id>\` to choose deliberately ` +
    `(available: ${Object.keys(PRESETS).sort().join(', ')}).`;
}

/** The live id `presetId` names, following one alias hop. Unknown ids pass through
 * unchanged so `resolveStyle` is the single place that refuses them. */
export function canonicalStyleId(presetId: string = DEFAULT_STYLE_PRESET_ID): string {
  return STYLE_ALIASES[presetId] ?? presetId;
}

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
  // a retired id resolves rather than throwing (STYLE_ALIASES); the caller asks
  // `styleAliasNote` for the warning that goes with it
  const id = canonicalStyleId(presetId);
  // Object.hasOwn, not a bare index: `--style __proto__` would otherwise find
  // Object.prototype and die later as a confusing TypeError (m7)
  if (!Object.hasOwn(PRESETS, id)) {
    throw new Error(
      `Unknown style "${presetId}" - available: ${Object.keys(PRESETS).sort().join(', ')}` +
        `${
          Object.keys(STYLE_ALIASES).length > 0
            ? ` (retired ids that still resolve: ${Object.keys(STYLE_ALIASES).sort().join(', ')})`
            : ''
        }`,
    );
  }
  const base = PRESETS[id];
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
