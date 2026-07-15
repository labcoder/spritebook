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
import { type StylePreset, StylePresetSchema } from '@spritebook/schema';
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
