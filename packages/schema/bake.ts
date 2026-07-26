/**
 * Bake (D-010): BakeManifest is canonical; exporters are pure projections.
 * AOV atlas pages are rect-identical to the lit page (parallel-layout law).
 */
import { z } from 'zod';
import { BakeIdSchema, CharacterIdSchema, IsoTimeSchema } from './identity.ts';
import { RenderPassSchema } from './project.ts';
import { CacheKeyInputsSchema } from './cache.ts';
import { SCHEMA_VERSION } from './migrate.ts';

export const FrameRecordSchema = z.strictObject({
  clipId: z.string().min(1),
  /** index into CameraPreset.directions */
  direction: z.int().nonnegative(),
  frame: z.int().nonnegative(),
  pivotPx: z.strictObject({ x: z.number(), y: z.number() }),
  atlas: z.strictObject({
    pageIndex: z.int().nonnegative(),
    x: z.int().nonnegative(),
    y: z.int().nonnegative(),
    w: z.int().positive(),
    h: z.int().positive(),
  }),
  cacheHit: z.boolean(),
  /** present only when mirroring is enabled (D-008: opt-in per character) */
  mirroredFrom: z.strictObject({ direction: z.int().nonnegative() }).optional(),
});
export type FrameRecord = z.output<typeof FrameRecordSchema>;

export const AtlasPageSchema = z.strictObject({
  pageIndex: z.int().nonnegative(),
  pass: RenderPassSchema,
  sizePx: z.int().positive(),
  /** path, relative to the bake directory */
  png: z.string().min(1),
  /** parallel-layout law: AOV pages share rects with the lit page */
  layoutSharedWith: z.literal('lit'),
});
export type AtlasPage = z.output<typeof AtlasPageSchema>;

export const BakeMetricsSchema = z.strictObject({
  /** idle-loop changed px/frame; budget per preset (audit item 4) */
  flickerPct: z.number().min(0).max(100),
  cacheHitPct: z.number().min(0).max(100),
  wallTimeS: z.number().nonnegative(),
  framesTotal: z.int().nonnegative(),
});
export type BakeMetrics = z.output<typeof BakeMetricsSchema>;

export const QAFlagSchema = z.strictObject({
  /** known codes plus room for new detectors (audit item 3) */
  code: z.string().min(1),
  severity: z.enum(['warn', 'error']),
  /** powers "Open <stage> at flag" in the GUI */
  sourceStage: z.enum(['look', 'rig', 'anim', 'bake']),
  frameRefs: z.array(z.strictObject({
    clipId: z.string().min(1),
    direction: z.int().nonnegative(),
    frame: z.int().nonnegative(),
  })),
  message: z.string().min(1),
});
export type QAFlag = z.output<typeof QAFlagSchema>;

/**
 * How one clip was sampled, in terms an exporter can act on.
 *
 * The bindings reach `inputs.clipBindingHash` as a sha256, which proves two
 * bakes used the same recipe but tells an exporter nothing — so Godot used to
 * hardcode `loop: true` for every clip (a death animation restarted forever)
 * and one `--fps` was applied to clips of different lengths. Every field here
 * is DERIVED from data already inside that hash, so this can never disagree
 * with the cache key and two bakes of one recipe stay byte-identical.
 *
 * `loop` comes from the binding's `holdLast`, not from the pack's clip
 * metadata: `holdLast` is the user's explicit `!hold`, it is already part of
 * the cache key, and `anim/contracts.ts` already defines the pair as "loop
 * (holdLast=false)". The pack's own `loop` flag is a filename heuristic
 * (`name.endsWith('_Loop')`) that sits OUTSIDE the hash, so honouring it would
 * let two recipes differing only in `loop` collide on one bakeId.
 */
export const ClipTimingSchema = z.strictObject({
  clipId: z.string().min(1),
  frames: z.int().positive(),
  speed: z.number().positive(),
  holdLast: z.boolean(),
  /** playback should loop — the inverse of holdLast */
  loop: z.boolean(),
  /** frames / (durationS / speed): the rate that replays the clip at `speed` */
  fps: z.number().positive(),
});
export type ClipTiming = z.output<typeof ClipTimingSchema>;

export const BakeManifestSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  bakeId: BakeIdSchema,
  characterId: CharacterIdSchema,
  /** the full recipe, embedded for provenance */
  inputs: CacheKeyInputsSchema,
  frames: z.array(FrameRecordSchema),
  atlases: z.array(AtlasPageSchema),
  metrics: BakeMetricsSchema,
  flags: z.array(QAFlagSchema),
  /**
   * Per-clip timing, for exporters. OPTIONAL and absent by default, the same
   * way `mirroredFrom` is: `runExportJob` parses manifests straight out of a
   * bake dir with no migration hook, so a required field would make every
   * already-baked directory unexportable.
   */
  clips: z.array(ClipTimingSchema).optional(),
  createdAt: IsoTimeSchema,
});
export type BakeManifest = z.output<typeof BakeManifestSchema>;
