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

/** `os-accel` pairs an entry can run on. A `-cpu` platform is satisfiable on
 * any machine with that OS; `-cuda`/`-metal` require the accelerator to be
 * detected. CUDA-only stacks (unconditional flash_attn/spconv imports) list
 * ONLY cuda platforms and macOS is excluded with a message, not a crash
 * (D-009; the P0-T4 platform verdict). */
export const PlatformSchema = z.enum([
  'windows-cuda',
  'linux-cuda',
  'macos-metal',
  'windows-cpu',
  'linux-cpu',
  'macos-cpu',
]);
export type Platform = z.output<typeof PlatformSchema>;

/** One weight file: where it lives inside the install dir, where it comes
 * from, and the exact content pin. The path grammar forbids traversal by
 * construction (each segment starts alphanumeric — no '..', no absolute, no
 * drive letters). */
export const WeightFileSchema = z.strictObject({
  path: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/,
    'relative path, alphanumeric-led segments',
  ),
  url: z.string().url(),
  /** the trust anchor is the hash, never the download source (sidecar-vram) */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.int().positive(),
});
export type WeightFile = z.output<typeof WeightFileSchema>;

export const ModelVersionSchema = z.strictObject({
  version: z.string().min(1),
  /** Staged multi-file releases are the norm (UniRig: skeleton + skin ckpts).
   * EMPTY is legal and meaningful: a backend that ships no weights at all —
   * procedural or bundled — still belongs in the catalog so it carries a
   * paramsSchema, gates, and an install receipt like every other backend.
   * Installing one is just the receipt. */
  files: z.array(WeightFileSchema),
  platforms: z.array(PlatformSchema).min(1),
  /** MEASURED peak for the configured path, never README claims (sidecar-vram) */
  minVramGb: z.number().positive().optional(),
  paramsSchema: JsonSchemaSchema,
  defaults: z.record(z.string(), z.unknown()),
  /** what a gen3d backend emits; geometry-only triggers the texture substage.
   * Required for gen3d entries (refined below), absent for rig/imageprep. */
  outputs: z.strictObject({
    geometry: z.literal(true),
    texture: z.boolean(),
    kind: z.enum(['mesh', 'gaussians']),
  }).optional(),
  notes: z.string().optional(),
});
export type ModelVersion = z.output<typeof ModelVersionSchema>;

/** Total install size of a version — derived, never stored twice. */
export function versionDiskBytes(v: ModelVersion): number {
  return v.files.reduce((n, f) => n + f.bytes, 0);
}

export const ModelEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(['gen3d', 'rig', 'imageprep']),
  displayName: z.string().min(1),
  license: LicenseInfoSchema,
  versions: z.array(ModelVersionSchema).min(1),
  notes: z.string().optional(),
}).superRefine((entry, ctx) => {
  for (const [i, v] of entry.versions.entries()) {
    if (entry.kind === 'gen3d' && !v.outputs) {
      ctx.addIssue({
        code: 'custom',
        path: ['versions', i, 'outputs'],
        message: 'gen3d entries must declare outputs (texture:false triggers the substage)',
      });
    }
    const seen = new Set<string>();
    for (const [j, f] of v.files.entries()) {
      if (seen.has(f.path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['versions', i, 'files', j, 'path'],
          message: `duplicate file path "${f.path}" in one version`,
        });
      }
      seen.add(f.path);
    }
  }
});
export type ModelEntry = z.output<typeof ModelEntrySchema>;

/** The bundled catalog document (packages/registry/catalog/models.json). */
export const ModelCatalogSchema = z.strictObject({
  schemaVersion: z.int().positive(),
  models: z.array(ModelEntrySchema),
}).superRefine((cat, ctx) => {
  const seen = new Set<string>();
  for (const [i, m] of cat.models.entries()) {
    if (seen.has(m.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['models', i, 'id'],
        message: `duplicate id "${m.id}"`,
      });
    }
    seen.add(m.id);
  }
});
export type ModelCatalog = z.output<typeof ModelCatalogSchema>;

/** Written next to installed weights AFTER every file's hash verified.
 * Records what the D-009 gates saw and what the user affirmed — the receipt
 * is the honest paper trail, not a lock. */
export const InstallReceiptSchema = z.strictObject({
  schemaVersion: z.int().positive(),
  modelId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().min(1),
  installedAt: z.string().min(1),
  /** platform detected at install time (os + accelerator probe) */
  platform: PlatformSchema,
  /** every file as verified on disk (re-checked by `models verify`); empty
   * for a weightless backend, whose receipt records only that the gates ran */
  files: z.array(z.strictObject({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.int().positive(),
  })),
  /** null when the license needs no acceptance; else the recorded consent */
  licenseAccepted: z.strictObject({
    name: z.string().min(1),
    spdx: z.string().optional(),
    at: z.string().min(1),
  }).nullable(),
  /** D-027: territory is an informed self-declaration (local-first, no
   * geolocation); required only when the license excludes territories */
  territoryDeclared: z.string().regex(/^[A-Z]{2}$/).optional(),
  vram: z.strictObject({
    minGb: z.number().positive().optional(),
    detectedGb: z.number().positive().optional(),
    /** install-time is advisory (warn); JOB-time preflight is the hard gate */
    status: z.enum(['ok', 'below-min', 'unknown', 'not-required']),
  }),
});
export type InstallReceipt = z.output<typeof InstallReceiptSchema>;

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
