/**
 * Character (data-models.ts v0.2) — the identity split is a law:
 * `id` (CharacterId) is immutable and binds cache keys, paths and CLI targets;
 * `displayName` is the ONLY field `spritebook rename` touches.
 */
import { z } from 'zod';
import { BakeIdSchema, CharacterIdSchema, IsoTimeSchema, Sha256Schema } from './identity.ts';
import { CameraOverridesSchema, StyleOverridesSchema } from './project.ts';
import { CHARACTER_SCHEMA_VERSION } from './migrate.ts';

export const SourceRecordSchema = z.strictObject({
  kind: z.enum(['image', 'mesh']),
  originalFilename: z.string().min(1),
  sha256: Sha256Schema,
  importedVia: z.strictObject({
    // 'three-fbx' is the D-020 interim FBX converter; 'ufbx' reserved for the
    // wasm binding once one exists upstream
    tool: z.enum(['gltf-transform', 'ufbx', 'obj2gltf', 'three-fbx']),
    version: z.string().min(1),
  }).optional(),
});
export type SourceRecord = z.output<typeof SourceRecordSchema>;

export const PreflightReportSchema = z.strictObject({
  at: IsoTimeSchema,
  checks: z.array(z.strictObject({
    /** known ids plus room for advisory extensions */
    id: z.string().min(1),
    status: z.enum(['ok', 'warn', 'fail', 'pending']),
    /** sentence case, advisory tone (copy rules) */
    message: z.string().min(1),
    fixApplied: z.string().optional(),
  })),
});
export type PreflightReport = z.output<typeof PreflightReportSchema>;

/** Pre-canonical working set: every generation attempt is a receipt. */
export const GenerationResultSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  backend: z.strictObject({ modelId: z.string().min(1), version: z.string().min(1) }),
  /** validated against the backend's paramsSchema by core at job time */
  params: z.record(z.string(), z.unknown()),
  /** recorded provenance — "re-run exactly this" */
  seed: z.int().nonnegative(),
  startedAt: IsoTimeSchema,
  wallTimeS: z.number().nonnegative(),
  output: z.strictObject({
    gltfSha256: Sha256Schema,
    tris: z.int().positive(),
    textureRes: z.int().positive().optional(),
    kind: z.enum(['mesh', 'gaussians']),
  }),
  discarded: z.boolean(),
});
export type GenerationResult = z.output<typeof GenerationResultSchema>;

export const RigStateSchema = z.strictObject({
  track: z.enum(['A', 'B']),
  backend: z.strictObject({ modelId: z.string().min(1), version: z.string().min(1) }).optional(),
  skeletonProfile: z.enum(['ual-humanoid', 'generic']),
  jointCount: z.int().positive(),
  /** tier-1 repairs: recorded patch, replayable, feeds re-run hints */
  jointEdits: z.array(z.strictObject({
    joint: z.string().min(1),
    delta: z.tuple([z.number(), z.number(), z.number()]),
    mirrored: z.boolean(),
  })),
  /** tier-2 structural fixes, recorded for provenance */
  orientationFixes: z.array(
    z.enum(['face-front', 'feet-ground', 'center', 'rotate-90', 'rotate-180', 'rotate-270']),
  ),
  boneMask: z.record(z.string(), z.string()).optional(),
  sockets: z.array(z.strictObject({
    id: z.string().min(1),
    bone: z.string().min(1),
    localOffset: z.array(z.number()).length(3),
  })).optional(),
  accepted: z.boolean(),
});
export type RigState = z.output<typeof RigStateSchema>;

export const ClipBindingSchema = z.strictObject({
  clipId: z.string().min(1),
  packId: z.string().min(1),
  enabled: z.boolean(),
  /** sampled per direction */
  frames: z.int().positive(),
  speed: z.number().positive(),
  holdLast: z.boolean(),
});
export type ClipBinding = z.output<typeof ClipBindingSchema>;

export const DetailLayerSchema = z.strictObject({
  id: z.string().min(1),
  uvDecalPng: z.string().min(1),
  region: z.string().optional(),
});
export type DetailLayer = z.output<typeof DetailLayerSchema>;

export const AttachmentSchema = z.strictObject({
  id: z.string().min(1),
  socketId: z.string().min(1),
  meshSha256: Sha256Schema,
});
export type Attachment = z.output<typeof AttachmentSchema>;

export const CharacterManifestSchema = z.strictObject({
  schemaVersion: z.literal(CHARACTER_SCHEMA_VERSION),
  /** immutable — minted at creation (see identity.ts) */
  id: CharacterIdSchema,
  /** mutable; `spritebook rename` touches only this */
  displayName: z.string().min(1),
  createdAt: IsoTimeSchema,
  source: SourceRecordSchema,
  // REMOVED in v3 (D-029): `preflight` used to sit here. The authoritative
  // report lives at results/<resultId>/preflight.json — one import, one report
  // — and the manifest's copy was a second thing that could disagree with it.
  // Nothing ever read it. PreflightReportSchema stays; it is the schema of that
  // file, which @spritebook/importer still writes.
  generation: z.strictObject({
    results: z.array(GenerationResultSchema),
    pickedResultId: z.string().optional(),
  }),
  canonicalMesh: z.strictObject({
    gltfSha256: Sha256Schema,
    heightM: z.number().positive(),
    texturedBy: z.enum(['backend', 'texture-substage']),
    reprojected: z.boolean(),
  }).optional(),
  rig: RigStateSchema.optional(),
  /** The character's own clip choices (D-029). `bake` reads the ENABLED ones as
   * defaults when `--clips` is absent, and merges what it ran back over these
   * — a binding kept as `enabled: false` survives, because it is a choice the
   * bake was never asked about. Clip content is hashed into the bake key
   * alongside the binding, so an in-place pack upgrade invalidates. */
  animationSet: z.array(ClipBindingSchema).optional(),
  /** The character's own camera + style (D-029). `bake --workspace` reads this
   * as its defaults and writes back what it ran with; any explicit flag wins.
   * P4's Look stage edits it.
   *
   * Both ids resolve against a built-in table — `CAMERA_PRESETS` in
   * @spritebook/core, `PRESETS` in @spritebook/style — and both sides take
   * overrides for the same reason: the PRD's Look stage exposes controls that
   * are not detents (direction count, px/m, cell size beside the elevation
   * slider; outline width and palette beside the style picker), and a
   * per-character choice on one of those must not require minting a preset. */
  look: z.strictObject({
    cameraPresetId: z.string().min(1),
    cameraOverrides: CameraOverridesSchema.optional(),
    stylePresetId: z.string().min(1),
    overrides: StyleOverridesSchema.optional(),
  }).optional(),
  /** OPT-IN (D-008): asymmetry is first-class, so this is never inferred from
   * GEOMETRY. `bake` does read it — `--mirror` records the choice here and
   * later bakes honour it without the flag, which is the same explicit decision
   * remembered, not a guess. `--no-mirror` overrides it for one bake. */
  mirroring: z.strictObject({ enabled: z.boolean() }),
  detailLayers: z.array(DetailLayerSchema).optional(),
  attachments: z.array(AttachmentSchema).optional(),
  /** The character's most recent bake (D-029), written by `bake --workspace` in
   * the same journaled patch as `look`, `animationSet` and `mirroring` — one
   * undo takes the whole bake back rather than half of it. `cloneCharacter`
   * drops it: a copy has baked nothing. */
  lastBakeId: BakeIdSchema.optional(),
});
export type CharacterManifest = z.output<typeof CharacterManifestSchema>;
