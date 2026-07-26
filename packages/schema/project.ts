/**
 * Project & presets (data-models.ts v0.2).
 *
 * Divergence from the draft, documented: `ExportTargetId` was referenced but
 * never defined there — pinned here to the four in-tree exporters
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
  orthographic: z.literal(true),
});
export type CameraPreset = z.output<typeof CameraPresetSchema>;

export const RENDER_PASSES = ['lit', 'albedo', 'normal', 'depth', 'mask'] as const;
export const RenderPassSchema = z.enum(RENDER_PASSES);
export type RenderPass = z.output<typeof RenderPassSchema>;

/** Base object shape — use for .partial() derivations (look.overrides). */
export const StylePresetBaseSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    mode: z.enum(['cel', 'pixel', 'painterly']),
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
      widthPx: z.int().min(1).max(8),
      normalThreshold: z.number(),
      depthThresholdScaled: z.number(),
      colorFrom: z.union([z.literal('palette-dark'), z.string()]),
    }).optional(),
    temporal: z.strictObject({
      superSample: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
      clusterVote: z.boolean(),
      paletteHysteresisEps: z.number().nonnegative(),
      texelSnap: z.boolean(),
    }),
    passes: z.array(RenderPassSchema).min(1),
    alpha: z.strictObject({
      mode: z.enum(['1bit', 'soft']),
      cutoff: z.number().min(0).max(1).optional(),
      bleedPx: z.int().nonnegative(),
    }),
  });

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
