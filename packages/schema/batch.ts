/**
 * Batch documents (P4-T3): the roster manifest and the bake plan.
 *
 * Two documents, and the difference between them is the whole design:
 *
 *   RosterManifest  what characters EXIST under a root, and when each was last
 *                   touched. Cheap — a directory walk and a stat. DERIVED: it
 *                   is rewritten from the character.json files every scan and
 *                   is never read back as truth, so it cannot drift into a
 *                   second source of truth for anything a character owns.
 *
 *   BakePlan        what a `bake --all` WOULD do, and why, without doing any
 *                   of it. Expensive-ish — it hashes each canonical mesh and
 *                   resolves each look — but it renders nothing.
 *
 * The plan exists because the cache is all-or-none per character (every frame
 * key embeds the whole recipe; see packages/pack/cache.ts). At one character
 * that is a fine thing to discover by running the bake. At a hundred it is an
 * overnight run that either was or wasn't necessary, and "it re-rendered 4800
 * frames" is not an answer anybody can act on afterwards. So the plan names
 * the FIELD that changed per character, in the user's language, before a pixel
 * is committed.
 *
 * `--changed-since` and staleness are deliberately different questions:
 * mtime says a file was TOUCHED, the input diff says the pixels would DIFFER.
 * A rename touches the manifest and changes nothing (D-011), and the plan is
 * where that guarantee stops being a claim in a test and becomes a line the
 * user reads.
 */
import { z } from 'zod';
import { BakeIdSchema, CharacterIdSchema, IsoTimeSchema } from './identity.ts';
import { SCHEMA_VERSION } from './migrate.ts';

/** The derived index at the root of a workspace root. */
export const ROSTER_FILE = 'roster.json';
/** Where `bake --all --plan` writes its plan, next to the roster. */
export const PLAN_FILE = 'bake-plan.json';

export const RosterEntrySchema = z.strictObject({
  id: CharacterIdSchema,
  /** relative to the root, so a moved root stays valid */
  dir: z.string().min(1),
  displayName: z.string().min(1),
  /** character.json mtime — the cheap signal `--changed-since` compares */
  updatedAt: IsoTimeSchema,
  /** a picked canonical mesh exists; without one there is nothing to bake */
  ready: z.boolean(),
  lastBakeId: BakeIdSchema.optional(),
  lastBakedAt: IsoTimeSchema.optional(),
});
export type RosterEntry = z.output<typeof RosterEntrySchema>;

export const RosterManifestSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  root: z.string().min(1),
  scannedAt: IsoTimeSchema,
  /** sorted by id, so two scans of an unchanged root are byte-identical */
  characters: z.array(RosterEntrySchema),
  /**
   * Directories that hold a character.json this scan could not read or parse.
   * Reported rather than skipped silently: a batch that quietly baked 9 of 10
   * characters is the failure mode this whole task exists to prevent.
   */
  unreadable: z.array(z.strictObject({
    dir: z.string().min(1),
    error: z.string().min(1),
  })),
});
export type RosterManifest = z.output<typeof RosterManifestSchema>;

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * The CacheKeyInputs fields, as the things a user changed rather than as
 * hashes. `backend` is one reason even though it is three sub-fields: they
 * always move together (a re-generation) and splitting them would report a
 * paramsHash flip as if it were separate from the model that produced it.
 */
export const STALE_FIELDS = [
  'characterId',
  'canonicalMeshSha256',
  'rigStateHash',
  'clipBindingHash',
  'cameraPresetHash',
  'stylePresetHash',
  'lightRigHash',
  'rendererVersion',
  'backend',
] as const;
export const StaleFieldSchema = z.enum(STALE_FIELDS);
export type StaleField = z.output<typeof StaleFieldSchema>;

export const StaleReasonSchema = z.strictObject({
  field: StaleFieldSchema,
  /** the sentence a user can act on — never a hash on its own */
  why: z.string().min(1),
  /** short forms of the two values, for anyone who wants to see the flip */
  from: z.string().min(1),
  to: z.string().min(1),
});
export type StaleReason = z.output<typeof StaleReasonSchema>;

/**
 * - never-baked  no recorded bake; everything is work
 * - stale        a recorded bake, and at least one input differs
 * - fresh        a recorded bake and every input matches: nothing to do
 * - blocked      cannot bake at all (no canonical mesh, unreadable manifest)
 * - unknown      the plan could not decide, and says which part it could not
 *                compute (no GPU adapter means no renderer signature, and
 *                guessing "fresh" there would skip real work)
 */
export const PLAN_STATES = ['never-baked', 'stale', 'fresh', 'blocked', 'unknown'] as const;
export const PlanStateSchema = z.enum(PLAN_STATES);
export type PlanState = z.output<typeof PlanStateSchema>;

export const BakePlanEntrySchema = z.strictObject({
  id: CharacterIdSchema,
  dir: z.string().min(1),
  displayName: z.string().min(1),
  state: PlanStateSchema,
  reasons: z.array(StaleReasonSchema),
  /**
   * Cells this bake would produce — directions × frames, summed over the
   * enabled clips. The same count a BakeManifest reports as
   * `metrics.framesTotal`, so a plan and the bake it predicted are directly
   * comparable. 0 when the plan could not resolve a recipe at all.
   */
  frames: z.int().nonnegative(),
  /** how many of those would re-render rather than hit cache — all-or-none */
  staleFrames: z.int().nonnegative(),
  lastBakeId: BakeIdSchema.optional(),
  lastBakedAt: IsoTimeSchema.optional(),
  /** why blocked, or which part of the comparison was unknown */
  note: z.string().optional(),
});
export type BakePlanEntry = z.output<typeof BakePlanEntrySchema>;

export const BakePlanSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  root: z.string().min(1),
  plannedAt: IsoTimeSchema,
  /** the `--changed-since` prefilter this plan was taken under, if any */
  changedSince: IsoTimeSchema.optional(),
  characters: z.array(BakePlanEntrySchema),
  totals: z.strictObject({
    /** characters the plan considered (after any --changed-since filter) */
    considered: z.int().nonnegative(),
    toBake: z.int().nonnegative(),
    fresh: z.int().nonnegative(),
    blocked: z.int().nonnegative(),
    unknown: z.int().nonnegative(),
    staleFrames: z.int().nonnegative(),
    /**
     * Frames a fresh character already has on disk and will not produce again.
     * NOT the frame cache (`bake --cache`, which is opt-in and separate): a
     * fresh character is skipped outright, so these frames cost nothing at all
     * rather than costing a cache lookup.
     */
    cachedFrames: z.int().nonnegative(),
  }),
});
export type BakePlan = z.output<typeof BakePlanSchema>;
