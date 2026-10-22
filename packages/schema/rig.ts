/**
 * Rigging contracts (P3-T3): the NEUTRAL data an auto-rig adapter returns, the
 * repair vocabulary, and the deform-check report.
 *
 * ## Why neutral data and not a rigged file
 *
 * Upstream auto-riggers drive Blender (GPL) to write their output. SpriteBook
 * ships no GPL code, so the boundary is drawn here (architecture.md): bpy runs
 * INSIDE the sidecar process, the adapter returns a skeleton + weights as
 * plain arrays, and CORE applies them to glTF itself. That keeps the licence
 * boundary at a data seam rather than a linking one, and it means the rig that
 * lands in the manifest was built by code we can test.
 *
 * ## The files an adapter writes
 *
 *   <outDir>/rig.json   RigSkeleton — joints, parents, rest transforms, names
 *   <outDir>/rig.npz    weights: per-vertex joint indices + weights (packed)
 *
 * JSON carries the small structured part so it is diffable and greppable; the
 * per-vertex arrays go in npz because they are large and numeric. Core reads
 * both by path (D-004: only paths and JobEvents cross the seam).
 */
import { z } from 'zod';

/** Where a rig adapter writes its two output files. */
export const RIG_SKELETON_FILE = 'rig.json';
export const RIG_WEIGHTS_FILE = 'rig.npz';

/** Artifact kinds a rig adapter emits. */
export const RIG_ARTIFACT_SKELETON = 'rig-skeleton';
export const RIG_ARTIFACT_WEIGHTS = 'rig-weights';

/**
 * One joint of a predicted skeleton. `head`/`tail` are in the MESH's own
 * space (the adapter never re-orients geometry — orientation repair is core's
 * job, and doing it in two places is how the two disagree). `parent` is an
 * index into the same array, -1 for the root, and must always point at a
 * LOWER index so the array is topologically ordered by construction.
 */
export const RigJointSchema = z.strictObject({
  name: z.string().min(1),
  parent: z.int().gte(-1),
  head: z.tuple([z.number(), z.number(), z.number()]),
  tail: z.tuple([z.number(), z.number(), z.number()]),
});
export type RigJoint = z.output<typeof RigJointSchema>;

/**
 * The adapter's skeleton output. `semanticNames` records whether the joint
 * names mean anything (a naming pass ran) or are positional placeholders like
 * `bone_7` — P0-T4 catalog item 3: generic names silently break every
 * name-based tool downstream, so the fact is recorded rather than guessed at.
 */
export const RigSkeletonSchema = z.strictObject({
  schemaVersion: z.int().positive(),
  backend: z.strictObject({ modelId: z.string().min(1), version: z.string().min(1) }),
  seed: z.int().nonnegative(),
  joints: z.array(RigJointSchema).min(1),
  semanticNames: z.boolean(),
  /** vertex count the weights file must agree with */
  vertexCount: z.int().positive(),
  /** max joints influencing one vertex (glTF's JOINTS_0 holds 4) */
  influencesPerVertex: z.int().positive(),
  /** numeric evidence the adapter gathered about its own output */
  validation: z.strictObject({
    nonFiniteWeights: z.int().nonnegative(),
    /** vertices whose weights did not sum to ~1 before renormalization */
    unnormalizedVertices: z.int().nonnegative(),
    /** vertices with no influence at all — they would collapse to the origin */
    zeroWeightVertices: z.int().nonnegative(),
    /** how many times the adapter retried on a fresh seed (NaN auto-repair) */
    retries: z.int().nonnegative(),
  }),
});
export type RigSkeleton = z.output<typeof RigSkeletonSchema>;

/**
 * A joint placement hint: "put this joint HERE instead". Produced by tier-1
 * repairs (`rig --edits`) and fed back with `--rerun-with-hints` so a nudge
 * the user already made becomes a marker the model is asked to respect,
 * rather than an edit they have to make again after every re-run.
 */
export const RigHintSchema = z.strictObject({
  joint: z.string().min(1),
  position: z.tuple([z.number(), z.number(), z.number()]),
});
export type RigHint = z.output<typeof RigHintSchema>;

export const RigAdapterParamsSchema = z.strictObject({
  /** the canonical mesh to rig */
  meshPath: z.string().min(1),
  outDir: z.string().min(1),
  seed: z.int().nonnegative(),
  modelDir: z.string().min(1),
  /** optional joint placement markers (the re-run-with-hints escape hatch) */
  hints: z.array(RigHintSchema).optional(),
});
export type RigAdapterParams = z.output<typeof RigAdapterParamsSchema>;

// ---------------------------------------------------------------------------
// Repair vocabulary
// ---------------------------------------------------------------------------

/** Tier-2 structural fixes — whole-model transforms, recorded for provenance. */
export const ORIENTATION_FIXES = [
  'upright',
  'face-front',
  'feet-ground',
  'center',
  'rotate-90',
  'rotate-180',
  'rotate-270',
] as const;
export type OrientationFix = (typeof ORIENTATION_FIXES)[number];

/**
 * Tier-1 repair: a joint nudge. `mirrored` applies the mirrored delta to the
 * side partner too — the common case when a user fixes a shoulder and means
 * both shoulders (D-008 keeps this OPT-IN, never automatic, because
 * asymmetric characters are first-class).
 */
export const JointEditSchema = z.strictObject({
  joint: z.string().min(1),
  delta: z.tuple([z.number(), z.number(), z.number()]),
  mirrored: z.boolean(),
});
export type JointEdit = z.output<typeof JointEditSchema>;

/** `rig --edits <patch.json>` reads this. */
export const JointEditsFileSchema = z.strictObject({
  edits: z.array(JointEditSchema).min(1),
});

// ---------------------------------------------------------------------------
// Orientation detection
// ---------------------------------------------------------------------------

/**
 * What the facing check concluded. SpriteBook's canonical convention is +Z
 * facing (D-012); a mesh that arrives facing elsewhere renders every direction
 * wrong in a way that is easy to miss until a whole bake looks subtly off, so
 * the check runs on rig entry and SUGGESTS a fix rather than silently applying
 * one (the user may have imported something deliberately odd).
 */
export const FacingReportSchema = z.strictObject({
  /** the axis the subject appears to face */
  facing: z.enum(['+Z', '-Z', '+X', '-X', 'unknown']),
  /** 0..1 — how strongly the geometry supports that call */
  confidence: z.number().min(0).max(1),
  /** the verb that would fix it, when a fix is needed */
  suggestedFix: z.enum(ORIENTATION_FIXES).optional(),
  /** the measurements behind the call, so a wrong verdict is debuggable */
  evidence: z.record(z.string(), z.number()),
});
export type FacingReport = z.output<typeof FacingReportSchema>;

// ---------------------------------------------------------------------------
// Deform check
// ---------------------------------------------------------------------------

/**
 * Per-joint deviation when the rig is driven through the test poses. This is
 * the numeric half of "does the rig actually deform well" — the contact sheets
 * are the human half. A joint whose influenced vertices barely move across
 * poses is suspicious (dead joint); one whose vertices move wildly relative to
 * their neighbours is the shredding failure P0-T4 catalogued (item 1).
 *
 * The poses are generated PROCEDURALLY from the rig itself — each joint bent
 * a fixed angle about its own dominant axis — rather than replayed from the
 * UAL test-pose pack. Track B rigs are generic: 22 to 52 joints, often named
 * `bone_7`, sometimes not even humanoid (the P0-T4 giraffe). A humanoid clip
 * cannot be applied to those without a retarget mapping that by definition
 * does not exist yet, whereas bending each joint in turn works on any skeleton
 * and measures exactly what the check is for. The UAL-derived pose pack
 * remains the right instrument for HUMANOID-profile rigs (Track A, P3-T4).
 */
export const DeformJointStatSchema = z.strictObject({
  joint: z.string().min(1),
  /** Parent name for inspection; absent in reports from older builds. */
  parent: z.string().nullable().optional(),
  /** vertices this joint influences above the weight floor */
  influencedVertices: z.int().nonnegative(),
  /** edges with BOTH endpoints influenced — the denominator of the seam rule */
  influencedEdges: z.int().nonnegative(),
  /** of those, edges whose length ratio exceeded the stretch threshold */
  stretchedEdges: z.int().nonnegative(),
  /** Separate mesh surfaces influenced, including clothing and accessories. */
  spannedComponents: z.int().nonnegative(),
  /** mean/max displacement of those vertices across the pose set, metres */
  meanDisplacementM: z.number().nonnegative(),
  maxDisplacementM: z.number().nonnegative(),
  /** max stretch factor of an edge inside the influenced set (1 = rigid);
   * SEVERITY only — the flag is the seam rule over stretchedEdges, because a
   * max over tens of thousands of edges saturates on dense meshes */
  maxEdgeStretch: z.number().nonnegative(),
  flags: z.array(z.enum(['dead-joint', 'excessive-stretch', 'no-influence'])),
});
export type DeformJointStat = z.output<typeof DeformJointStatSchema>;

export const DeformReportSchema = z.strictObject({
  schemaVersion: z.int().positive(),
  at: z.string().min(1),
  poses: z.array(z.string().min(1)).min(1),
  joints: z.array(DeformJointStatSchema),
  /** joints whose flags are non-empty, for a one-line summary */
  flaggedJoints: z.array(z.string()),
});
export type DeformReport = z.output<typeof DeformReportSchema>;
