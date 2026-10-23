/**
 * Project and preset contracts.
 *
 * `ExportTargetId` is pinned to the four in-tree exporters
 * (architecture: "no plugin system in 1.0; exporters are in-tree projections").
 */
import { z } from 'zod';
import { ProjectIdSchema } from './identity.ts';
import { ProjectPinsSchema } from './registry.ts';
import { SCHEMA_VERSION } from './migrate.ts';

export const ExportTargetIdSchema = z.enum(['godot', 'aseprite', 'texturepacker', 'strips']);
export type ExportTargetId = z.output<typeof ExportTargetIdSchema>;

export const CameraPresetSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /**
   * detents in the GUI: 15 | 26.565 (2:1) | 30 | 35.264 (iso) — any value valid.
   * Excludes exactly 90° (pure top-down): the ortho framing solver degenerates
   * there (world-up ∥ view); a bird's-eye path is future work.
   */
  elevationDeg: z.number().min(0).lt(90),
  directions: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
  yawOffsetDeg: z.number(),
  /** world-locked scale: the roster shares one ruler */
  pixelsPerMeter: z.number().positive(),
  cellPx: z.strictObject({ w: z.int().positive(), h: z.int().positive() }),
  /** must exceed outline width — cross-preset rule enforced by core at bind time */
  paddingPx: z.int().nonnegative(),
  pivot: z.union([
    z.literal('feet-baseline'),
    z.literal('center'),
    z.strictObject({ xPct: z.number().min(0).max(100), yPct: z.number().min(0).max(100) }),
  ]),
  orthographic: z.boolean(),
  /** Perspective vertical field of view; scale is measured at the pivot plane. */
  fovDeg: z.number().min(10).max(90).optional(),
});
export type CameraPreset = z.output<typeof CameraPresetSchema>;

/**
 * A partial camera, for refining a named preset (`look.cameraOverrides`).
 *
 * Direction count, px/m and cell size are per-character choices alongside
 * elevation, so the camera uses the same preset-id + overrides shape as style.
 *
 * `id` is omitted deliberately: an override refines a preset, it does not
 * rename one. The resolved camera keeps the preset's id so a bake manifest can
 * still say where its framing came from.
 */
export const CameraOverridesSchema = CameraPresetSchema.omit({ id: true }).partial();
export type CameraOverrides = z.output<typeof CameraOverridesSchema>;

export const RENDER_PASSES = ['lit', 'albedo', 'normal', 'depth', 'mask'] as const;
export const RenderPassSchema = z.enum(RENDER_PASSES);
export type RenderPass = z.output<typeof RenderPassSchema>;

export const LightingSchema = z.strictObject({
  direction: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
    .refine((v) => Math.hypot(...v) > 1e-6, 'Light direction must not be zero'),
  ambient: z.number().min(0).max(1),
  frame: z.enum(['world', 'camera']),
});
export type Lighting = z.output<typeof LightingSchema>;

/** Base object shape — use for .partial() derivations (look.overrides). */
export const StylePresetBaseSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    /**
     * UNREAD by the pipeline. Behaviour comes entirely from
     * `temporal.clusterVote` + `quantize`; nothing branches on this. Kept as
     * the preset's human label and for the GUI's preset picker.
     */
    mode: z.enum(['cel', 'pixel', 'painterly']),
    lighting: LightingSchema.optional(),
    ramp: z.strictObject({
      stops: z.int().min(2).max(8),
      rimStrength: z.number().min(0).max(1),
    }).optional(),
    quantize: z.strictObject({
      /** 'adaptive' = per-character palette over all frames, computed once */
      palette: z.union([z.literal('adaptive'), z.array(z.string()).min(1)]),
      maxColors: z.int().min(2).max(256),
      space: z.literal('oklab'),
      dither: z.union([
        z.strictObject({
          kind: z.literal('ordered'),
          matrix: z.union([z.literal(4), z.literal(8)]),
          strength: z.number().min(0).max(1),
        }),
        z.strictObject({ kind: z.literal('none') }),
      ]),
    }).optional(),
    outline: z.strictObject({
      /** 1x stroke width. FRACTIONAL is allowed and is the only way to thin the
       * stroke at small cells: the render is supersampled, so 0.5 with S=4 is a
       * 2-texel Sx stroke that downsamples to a partial pixel. An integer floor
       * of 1 meant a 64 px cell had no thinner setting available, and on a slim
       * character a 1 px inward stroke from both sides of a 3 px limb IS the
       * limb - measured at 67% of bulma's silhouette. */
      widthPx: z.number().min(0.25).max(8),
      /** Drop the SILHOUETTE stroke where the shape is too thin to survive it,
       * keeping creases. 0 (the default) is the old unconditional behaviour.
       *
       * The test is a morphological opening by the stroke radius: a region that
       * erodes to nothing has no interior left once outlined, so outlining it
       * replaces the character rather than describing it. Creases are exempt
       * because an interior line on a thin limb is what still reads as detail. */
      minSpanPx: z.number().min(0).max(8).optional(),
      normalThreshold: z.number(),
      depthThresholdScaled: z.number(),
      colorFrom: z.union([z.literal('palette-dark'), z.string()]),
    }).optional(),
    temporal: z.strictObject({
      superSample: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
      clusterVote: z.boolean(),
      paletteHysteresisEps: z.number().nonnegative(),
      /**
       * UNREAD by the pipeline, like `mode` and `passes` below. `camera.ts`
       * snaps the pivot onto the texel lattice unconditionally, so `false`
       * renders byte-identically to `true`.
       *
       * Carried rather than dropped, and the reason is worth stating so nobody
       * re-opens it as a bug: an unsnapped pivot lands a sprite on a half-texel
       * and every frame of that direction shimmers against its neighbours, so
       * `false` is not a mode anyone should get. Deleting the field is the
       * honest alternative, but it lives on StylePreset, which reaches Project
       * and `look.overrides`, and that costs a schema version bump to remove a
       * field whose only correct value is the one it already has.
       */
      texelSnap: z.boolean(),
    }),
    /**
     * UNREAD beyond the "must include lit" refinement below: the renderer
     * always writes all five AOVs and readAov always reads all five, so
     * `passes: ['lit']` buys nothing today.
     */
    passes: z.array(RenderPassSchema).min(1),
    alpha: z.strictObject({
      mode: z.enum(['1bit', 'soft']),
      cutoff: z.number().min(0).max(1).optional(),
      bleedPx: z.int().nonnegative(),
    }),
  });

/**
 * A partial style, for refining a named preset (`look.overrides`).
 *
 * `id` is omitted for the same reason it is on CameraOverridesSchema: an
 * override refines a preset, it does not rename one, and the resolved style
 * keeps the preset's id so a bake manifest can say where its look came from.
 *
 * There is no `.superRefine` here and there cannot be — the cross-field rules
 * below judge a WHOLE style ("cutoff is required when mode is 1bit"), and a
 * partial has no whole to judge. `resolveStyle` re-validates the merged result
 * against StylePresetSchema, which is where those rules get their say.
 */
export const StyleOverridesSchema = StylePresetBaseSchema.omit({ id: true }).partial();
export type StyleOverrides = z.output<typeof StyleOverridesSchema>;

export const StylePresetSchema = StylePresetBaseSchema
  .superRefine((v, ctx) => {
    if (v.alpha.mode === '1bit' && v.alpha.cutoff === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['alpha', 'cutoff'],
        message: "alpha.cutoff is required when alpha.mode is '1bit'",
      });
    }
    if (!v.passes.includes('lit')) {
      ctx.addIssue({
        code: 'custom',
        path: ['passes'],
        message: "passes must include 'lit' (AOV pages share the lit layout, D-010)",
      });
    }
    if (
      Array.isArray(v.quantize?.palette) && v.quantize.palette.length > v.quantize.maxColors
    ) {
      // `buildPalette` hands a fixed palette straight to `paletteFromHex` and
      // never consults maxColors, so 40 hex colours with maxColors 8 painted
      // with 40 — the user set a ceiling and the pipeline ignored it. Refused
      // rather than truncated: silently dropping the last 32 colours the user
      // typed is the same class of wrong, and which 32 would be our guess.
      ctx.addIssue({
        code: 'custom',
        path: ['quantize', 'palette'],
        message: `a fixed palette of ${v.quantize.palette.length} colors exceeds maxColors ` +
          `${v.quantize.maxColors} — raise maxColors or shorten the palette; the pipeline ` +
          `paints with every color you list, so the two must agree`,
      });
    }
    if (v.temporal.clusterVote && v.quantize === undefined) {
      // Cluster-vote downsamples palette LABELS, so with no palette every
      // opaque pixel labels as -1 and the sprite comes out entirely blank —
      // while the job reports done and flickerPct 0, which reads as a PERFECT
      // stability score. Refused here so the state cannot be expressed.
      ctx.addIssue({
        code: 'custom',
        path: ['quantize'],
        message: 'temporal.clusterVote requires quantize: the vote is taken over palette labels, ' +
          'so without a palette every pixel votes -1 and the sprite is blank',
      });
    }
  });
export type StylePreset = z.output<typeof StylePresetSchema>;

export const ProjectSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: ProjectIdSchema,
  name: z.string().min(1),
  pins: ProjectPinsSchema,
  cameraPresets: z.array(CameraPresetSchema).min(1),
  stylePresets: z.array(StylePresetSchema).min(1),
  defaults: z.strictObject({
    cameraPresetId: z.string(),
    stylePresetId: z.string(),
    exportTargets: z.array(ExportTargetIdSchema),
  }),
});
export type Project = z.output<typeof ProjectSchema>;
