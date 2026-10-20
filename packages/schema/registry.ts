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

/** What a backend can be ASKED to do. The first three mirror `ModelEntry.kind`;
 * `retexture` is the first operation that is not a kind of its own, because it
 * is the same model doing a second thing (mesh + image -> mesh) rather than a
 * different model.
 *
 * Verbs resolve a backend by asking who declares the capability, never by name:
 * `retexture` finds trellis2 because trellis2 says it can retexture, so a second
 * texturing backend drops in as catalog data with no code change (D-009). */
export const CapabilitySchema = z.enum(['gen3d', 'rig', 'imageprep', 'retexture']);
export type Capability = z.output<typeof CapabilitySchema>;

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
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, 'version path segment'),
  /** Staged multi-file releases are the norm (UniRig: skeleton + skin ckpts).
   * EMPTY is legal and meaningful: a backend that ships no weights at all —
   * procedural or bundled — still belongs in the catalog so it carries a
   * paramsSchema, gates, and an install receipt like every other backend.
   * Installing one is just the receipt. */
  files: z.array(WeightFileSchema),
  platforms: z.array(PlatformSchema).min(1),
  /** App-owned, hash-pinned source and wheel setup recipe; weights remain separate. */
  runtime: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  /** MEASURED peak for the configured path, never README claims (sidecar-vram) */
  minVramGb: z.number().positive().optional(),
  /** Conservative admission claims tied to measured operation/configuration paths. */
  vramProfiles: z.array(z.strictObject({
    operation: CapabilitySchema,
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    minGb: z.number().positive(),
    evidence: z.string().min(1),
  })).min(1).optional(),
  paramsSchema: JsonSchemaSchema,
  defaults: z.record(z.string(), z.unknown()),
  /** Everything this version can do. Absent means "the entry's `kind`, and only
   * that" — the common case, so most entries stay as they were. */
  capabilities: z.array(CapabilitySchema).min(1).optional(),
  /** Defaults that apply to ONE operation, layered over `defaults`.
   *
   * They exist because the same parameter can need a different value per
   * operation on the same model: trellis2's texture decoder collapses on ~5% of
   * seeds when generating and 37.5% when retexturing, so a single shared
   * `textureRetries` is wrong for one of them whichever value it takes. The
   * budget is catalog data for the same reason the model is — the next backend
   * has its own rate and must not have to argue with ours.
   *
   * `partialRecord`, not `record`: an enum-keyed `z.record` is EXHAUSTIVE in
   * zod 4 and would demand a block for every capability that exists. */
  operationDefaults: z.partialRecord(CapabilitySchema, z.record(z.string(), z.unknown()))
    .optional(),
  /** The knobs ONE operation accepts, when `paramsSchema` is a union across
   * several.
   *
   * trellis2-4b generates and retextures behind one schema, and that union
   * reads as a menu: `resolution` belongs to the retexture sampler alone, but
   * nothing said so. A `gen --adjust resolution=1024` was refused by the
   * sidecar's own schema with no useful sentence, and the Studio's options
   * form — rendered from the same union — OFFERED the knob first. Declaring
   * the sets makes the narrower schema derivable (`paramsSchemaFor`), so the
   * gate, the error message, and the form all agree.
   *
   * Absent means "every property", which is right for every single-capability
   * backend in the roster. */
  operationParams: z.partialRecord(CapabilitySchema, z.array(z.string()).min(1)).optional(),
  /** Which SIDECAR ADAPTER runs each operation.
   *
   * "The catalog id is the adapter id" was the rule, and it was never true:
   * `trellis2-4b` is run by `trellis2` and `rembg-u2net` by `rembg`, so `gen`
   * asked the sidecar for an adapter that does not exist and `prep` worked only
   * because it hardcoded the name. Two operations on one model make the rule
   * unfixable anyway — trellis2-4b needs `trellis2` for gen3d and
   * `trellis2-retexture` for retexture, and one entry id cannot be both.
   *
   * Absent falls back to the entry id, which is correct for `unirig` and
   * `fixture-gen`. */
  adapters: z.partialRecord(
    CapabilitySchema,
    z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'adapter id slug'),
  ).optional(),
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

/** Everything this version can be asked to do, entry `kind` included.
 *
 * The kind is always in the set even when `capabilities` lists it too, so a
 * caller never has to check both fields — that double check is exactly where a
 * backend gets silently skipped. */
export function versionCapabilities(kind: ModelEntry['kind'], v: ModelVersion): Set<Capability> {
  return new Set<Capability>([kind, ...(v.capabilities ?? [])]);
}

export function versionCan(
  kind: ModelEntry['kind'],
  v: ModelVersion,
  op: Capability,
): boolean {
  return versionCapabilities(kind, v).has(op);
}

/** The defaults to run `op` with: the version's own, with the operation's
 * overrides on top. Callers pass this straight to the sidecar, so a parameter
 * that differs per operation differs in exactly one place — the catalog. */
export function defaultsFor(v: ModelVersion, op: Capability): Record<string, unknown> {
  return { ...v.defaults, ...(v.operationDefaults?.[op] ?? {}) };
}

/** The sidecar adapter that runs `op` for this version. */
export function adapterFor(entryId: string, v: ModelVersion, op: Capability): string {
  return v.adapters?.[op] ?? entryId;
}

/** Narrowed schemas are derived, and core caches compiled validators by schema
 * IDENTITY — so the same (version, op) must hand back the same object or every
 * job would recompile its own copy. */
const narrowed = new WeakMap<ModelVersion, Map<Capability, JSONSchema>>();

/** The paramsSchema for ONE operation: the version's, with the properties that
 * operation does not accept removed.
 *
 * This is the schema to validate against and the schema to render a form from.
 * A version that declares no `operationParams` for `op` gets its own schema
 * back unchanged — the common single-capability case pays nothing. */
export function paramsSchemaFor(v: ModelVersion, op: Capability): JSONSchema {
  const allow = v.operationParams?.[op];
  if (!allow) return v.paramsSchema;
  let byOp = narrowed.get(v);
  if (!byOp) narrowed.set(v, byOp = new Map());
  const hit = byOp.get(op);
  if (hit) return hit;
  const props = (v.paramsSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const kept: Record<string, unknown> = {};
  for (const key of allow) if (key in props) kept[key] = props[key];
  const schema: JSONSchema = { ...v.paramsSchema, properties: kept };
  byOp.set(op, schema);
  return schema;
}

/** Which operations accept `key` — the answer behind "resolution is a
 * retexture-only knob". Empty when the version declares no sets at all, which
 * reads correctly as "this backend has nothing to disambiguate". */
export function operationsAccepting(v: ModelVersion, key: string): Capability[] {
  const sets = v.operationParams;
  if (!sets) return [];
  return (Object.keys(sets) as Capability[])
    .filter((op) => sets[op]?.includes(key))
    .sort();
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
    // Defaults for an operation the backend never claims to do are dead data
    // that READS as configuration — the failure is a user setting a retry
    // budget under the wrong key and watching nothing change.
    const can = versionCapabilities(entry.kind, v);
    for (const field of ['operationDefaults', 'adapters', 'operationParams'] as const) {
      for (const op of Object.keys(v[field] ?? {})) {
        if (!can.has(op as Capability)) {
          ctx.addIssue({
            code: 'custom',
            path: ['versions', i, field, op],
            message: `${field} for "${op}", which this version does not declare it can do`,
          });
        }
      }
    }
    // A knob nobody declares is a knob nobody can set: the narrowed schema
    // drops it, so a typo here would silently DELETE a parameter rather than
    // fail. Both directions are checked — a listed key must exist, and a
    // declared operation must account for every property it wants to keep.
    const props = Object.keys((v.paramsSchema as { properties?: object }).properties ?? {});
    for (const [op, keys] of Object.entries(v.operationParams ?? {})) {
      for (const key of keys ?? []) {
        if (!props.includes(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['versions', i, 'operationParams', op],
            message: `operationParams lists "${key}", which paramsSchema does not describe`,
          });
        }
      }
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
    path: WeightFileSchema.shape.path,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.int().positive(),
  })),
  /** null when the license needs no acceptance; else the recorded consent */
  licenseAccepted: z.strictObject({
    name: z.string().min(1),
    spdx: z.string().optional(),
    at: z.string().min(1),
    /** Hash of the catalog's complete declared license terms at acceptance. */
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
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
  models: z.record(z.string(), z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)),
  packs: z.record(z.string(), z.string().min(1)),
  /**
   * The renderer build this project pins. NOTE: nothing reads it today — cache
   * keys carry `renderSignature()` (render/diagnostics.ts), which composes
   * RENDERER_VERSION with the adapter identity, and no code path consults this
   * field. It is a declared pin without an enforcer.
   */
  rendererVersion: z.string().min(1),
});
export type ProjectPins = z.output<typeof ProjectPinsSchema>;
