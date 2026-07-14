/**
 * Registry (D-009): catalog -> installed -> pins. Backends AND animation packs
 * are catalog data — licenses, territories, VRAM, paramsSchema — never
 * hardcoded integrations.
 */
import { z } from 'zod';

/** JSON Schema draft 2020-12 subset, stored as data (validates params, drives GUI forms). */
export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JSONSchema = z.output<typeof JsonSchemaSchema>;

export const LicenseInfoSchema = z.strictObject({
  spdx: z.string().optional(),
  name: z.string().min(1),
  url: z.string().url().optional(),
  requiresAcceptance: z.boolean(),
  excludedTerritories: z.array(z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2')).optional(),
});
export type LicenseInfo = z.output<typeof LicenseInfoSchema>;

export const ModelVersionSchema = z.strictObject({
  version: z.string().min(1),
  weightsUrl: z.string().url(),
  weightsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  diskBytes: z.int().nonnegative(),
  minVramGb: z.number().positive().optional(),
  paramsSchema: JsonSchemaSchema,
  defaults: z.record(z.string(), z.unknown()),
  outputs: z.strictObject({
    geometry: z.literal(true),
    texture: z.boolean(),
    kind: z.enum(['mesh', 'gaussians']),
  }),
});
export type ModelVersion = z.output<typeof ModelVersionSchema>;

export const ModelEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(['gen3d', 'rig', 'imageprep']),
  displayName: z.string().min(1),
  license: LicenseInfoSchema,
  versions: z.array(ModelVersionSchema).min(1),
  notes: z.string().optional(),
});
export type ModelEntry = z.output<typeof ModelEntrySchema>;

export const AnimationClipSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  packId: z.string().min(1),
  displayName: z.string().min(1),
  durationS: z.number().positive(),
  fpsSource: z.number().positive(),
  category: z.enum(['locomotion', 'idle', 'emote', 'combat', 'work', 'other']),
  tags: z.array(z.string()),
  rootMotion: z.boolean(),
  loop: z.boolean(),
});
export type AnimationClip = z.output<typeof AnimationClipSchema>;

export const AnimationPackSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string().min(1),
  license: LicenseInfoSchema,
  rigProfile: z.enum(['ual-humanoid', 'mixamo', 'custom']),
  /** bundled packs are redistributable; user imports never are */
  bundled: z.boolean(),
  clips: z.array(AnimationClipSchema),
});
export type AnimationPack = z.output<typeof AnimationPackSchema>;

export const ProjectPinsSchema = z.strictObject({
  models: z.record(z.string(), z.string()),
  packs: z.record(z.string(), z.string()),
  /** participates in every cache key (D-011) */
  rendererVersion: z.string().min(1),
});
export type ProjectPins = z.output<typeof ProjectPinsSchema>;
