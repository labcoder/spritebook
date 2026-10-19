import { workspaceJob } from '@spritebook/core';
/**
 * The `rig` job (P3-T3): predict a skeleton, apply it, check it deforms, and
 * record what happened — as a JobEvent stream like every other verb.
 *
 * The order is the contract, and each step earns its place from what P0-T4
 * saw go wrong:
 *
 *   1. FACING CHECK on entry. A mesh facing the wrong way produces a rig that
 *      succeeds and a bake where every direction is silently wrong, so the
 *      check runs first and warns with the verb that fixes it. It does not
 *      apply the fix — see orient.ts on why silence in either direction is
 *      worse than a warning.
 *   2. PREDICT via the sidecar (bpy stays behind that boundary).
 *   3. APPLY in core, which is where the glTF skin is actually built.
 *   4. DEFORM CHECK, because "the adapter exited 0" says nothing about
 *      whether the character bends (sidecar-vram: validate outputs, not exit
 *      codes) — flagged joints become warns rather than silent report entries.
 *
 * Repairs re-enter at different points, which is the whole reason the tiers
 * exist: tier 2 rewrites the mesh and needs a re-rig, tier 1 moves joints on
 * the rigged file and does not, and `--rerun-with-hints` feeds the user's
 * existing nudges back into step 2 so a correction is never made twice.
 */
import type {
  JobEvent,
  JointEdit,
  OrientationFix,
  RigHint,
  RigSkeleton,
  RigState,
} from '@spritebook/schema';
import {
  MANIFEST_FILE,
  parseWith,
  RIG_SKELETON_FILE,
  RIG_WEIGHTS_FILE,
  RigSkeletonSchema,
} from '@spritebook/schema';
import {
  acquireVramLeaseEvents,
  setRigState,
  SidecarSession,
  type VramLease,
  workspacePaths,
} from '@spritebook/core';
import { applyRig } from './apply.ts';
import { prepareCanonicalPromotion } from './promote.ts';
import { deformCheck } from './deform.ts';
import { applyOrientationFixes, detectFacingFile } from './orient.ts';
import { componentsOfFile, disconnectedWarning } from '@spritebook/importer';
import { applyEditsToRiggedGlb, applyJointEdits, hintsFromEdits } from './edits.ts';

export interface RigJobOptions {
  jobId: string;
  /** the canonical mesh to rig */
  modelPath: string;
  /** working directory for rig artifacts */
  outDir: string;
  /** the uv sidecar project dir */
  sidecarDir: string;
  /** where the registry installed the backend's weights */
  modelDir: string;
  /** adapter id in the sidecar roster */
  backend?: string;
  seed?: number;
  /** tier-2 structural fixes to apply BEFORE predicting */
  orientationFixes?: OrientationFix[];
  /** tier-1 nudges applied to the predicted skeleton */
  edits?: JointEdit[];
  /** feed `edits` back to the backend as placement markers instead */
  rerunWithHints?: boolean;
  /** skip the deform check (it costs a CPU pass over every joint) */
  skipDeformCheck?: boolean;
  /** character workspace; when given, the rig is recorded as a journaled
   * patch so `spritebook undo` can take a repair back */
  workspace?: string;
  /**
   * VRAM this backend holds while it predicts — the catalog's `minVramGb` for
   * the installed version. Resolved by the CALLER, because this job takes a
   * pre-resolved `modelDir` and deliberately never sees the catalog (see the
   * note by the adapter id below). Omitted or 0 takes no lease.
   */
  vramGb?: number;
  /** total machine VRAM; null/undefined means no budgeting at all */
  vramBudgetGb?: number | null;
  /** shared lease directory; defaults to the machine-wide one */
  vramLeaseDir?: string;
}

export interface RigJobSummary {
  jointCount: number;
  semanticNames: boolean;
  flaggedJoints: string[];
  orientationFixes: OrientationFix[];
  jointEdits: JointEdit[];
}

class RigFail extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

/**
 * Run one rig job. Event codes: facing-unknown (warn), rig-backend-failed,
 * rig-invalid-output, rig-apply-failed, deform-flagged (warn),
 * unknown-joint (warn).
 */
async function* executeRigJob(opts: RigJobOptions): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = opts.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  let session: SidecarSession | undefined;
  let lease: VramLease | undefined;
  try {
    await Deno.mkdir(opts.outDir, { recursive: true });
    // Taken BEFORE the orientation fixes and the facing check, cheap as those
    // are, because the alternative is worse: a job that rewrites the user's
    // mesh on disk and only then discovers it must queue for twenty minutes
    // has done half a thing. Track A's fit calls this with no gb and takes no
    // lease — it needs no GPU at all (D-026), so charging it for one would
    // stall the humanoid path behind the generic one for nothing.
    lease = yield* acquireVramLeaseEvents({
      gb: opts.vramGb ?? 0,
      jobId,
      budgetGb: opts.vramBudgetGb,
      ...(opts.vramLeaseDir !== undefined ? { dir: opts.vramLeaseDir } : {}),
    }, at);
    let meshPath = opts.modelPath;

    // 0. strip any EXISTING skin first. Both tracks promote their skinned
    // result to canonical, so the second rig of a character always receives
    // a skinned mesh; predict tolerated it, applyRig refused, and re-rigging
    // worked exactly once. Downstream of this line the pipeline only ever
    // sees clean geometry.
    const { stripSkinsFile } = await import('./strip.ts');
    const stripped = await stripSkinsFile(meshPath, `${opts.outDir}/stripped.glb`);
    if (stripped.result.skinsRemoved > 0) {
      meshPath = stripped.path;
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'mesh-already-skinned',
        message: `"${opts.modelPath}" already contains skin data - a previous rig. SpriteBook ` +
          `removed it (${stripped.result.attributesRemoved} vertex attributes, ` +
          `${stripped.result.jointNodesRemoved} joint nodes) and rigs the geometry alone; ` +
          `the old rig is replaced, never stacked.`,
      };
    }

    // 1. tier-2 fixes first when asked — they rewrite the mesh, so predicting
    // before them would rig a body that is about to move
    const fixes = opts.orientationFixes ?? [];
    if (fixes.length > 0) {
      const fixed = `${opts.outDir}/oriented.glb`;
      const { facingAfter } = await applyOrientationFixes(meshPath, fixed, fixes);
      meshPath = fixed;
      yield {
        t: 'artifact',
        jobId,
        at: at(),
        kind: 'rig-oriented-mesh',
        path: fixed,
      };
      yield {
        t: 'progress',
        jobId,
        at: at(),
        step: `orient:${facingAfter.facing}`,
        done: 1,
        total: 4,
      };
    }

    // the facing check ALWAYS runs, so a user who did not ask for a fix still
    // learns their character is backwards before a bake makes it expensive
    const facing = await detectFacingFile(meshPath);
    if (facing.suggestedFix && facing.confidence >= 0.2) {
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'facing-wrong',
        message: `This mesh appears to face ${facing.facing}; SpriteBook renders +Z as the ` +
          `front, so every baked direction would be rotated. Re-run with ` +
          `--${facing.suggestedFix} to fix it (confidence ${facing.confidence.toFixed(2)}).`,
      };
    } else if (facing.facing === 'unknown' || facing.confidence < 0.2) {
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'facing-unknown',
        message:
          `Could not tell which way this mesh faces (confidence ${
            facing.confidence.toFixed(2)
          }) - ` +
          `it may be symmetric. Check the first bake and use --face-front or --rotate if needed.`,
      };
    }
    // Detached geometry, BEFORE ~90 s of prediction. A skeleton is one chain
    // and cannot drive a shell it does not touch, so this ceiling is knowable
    // from the mesh alone - measured on robot-astro, whose floating hands held
    // its auto-hint repair to 18.5% -> 15.0% where a single-body mesh went
    // 12.7% -> 4.9%.
    const shells = await componentsOfFile(meshPath);
    const detached = disconnectedWarning(shells);
    if (detached) {
      yield { t: 'warn', jobId, at: at(), code: 'mesh-disconnected', message: detached };
    }
    yield { t: 'progress', jobId, at: at(), step: 'facing', done: 1, total: 4 };

    // 2. predict, through the sidecar
    const hints: RigHint[] = [];
    if (opts.rerunWithHints && opts.edits?.length) {
      // the user's existing nudges, as absolute markers for the model
      const priorPath = `${opts.outDir}/${RIG_SKELETON_FILE}`;
      try {
        const prior = parseWith(
          RigSkeletonSchema,
          JSON.parse(await Deno.readTextFile(priorPath)),
          'RigSkeleton',
        );
        hints.push(...hintsFromEdits(applyJointEdits(prior, opts.edits).skeleton, opts.edits));
      } catch {
        throw new RigFail(
          'rig-invalid-output',
          `--rerun-with-hints needs the previous ${RIG_SKELETON_FILE} in ${opts.outDir}, ` +
            `but it could not be read - run \`spritebook rig\` once first`,
        );
      }
    }

    session = new SidecarSession({ sidecarDir: opts.sidecarDir });
    // The catalog id doubling as the adapter id, which `gen` and `prep` stopped
    // assuming: `adapterFor` is the general answer, and this job cannot ask it
    // because it takes a pre-resolved modelDir and never sees the catalog. It
    // is correct for unirig, whose two names match. A rig backend whose names
    // differ has to thread the version through first.
    const backend = opts.backend ?? 'unirig';
    for await (
      const e of session.run({
        jobId: `${opts.jobId}-predict` as JobEvent['jobId'],
        kind: backend,
        params: {
          meshPath,
          outDir: opts.outDir,
          seed: opts.seed ?? 0,
          modelDir: opts.modelDir,
          ...(hints.length > 0 ? { hints } : {}),
        },
      })
    ) {
      if (e.t === 'error') {
        if (e.code === 'unknown-adapter') {
          throw new RigFail(
            'rig-backend-unavailable',
            `Rig backend "${backend}" is installed but this build has no adapter for it yet`,
          );
        }
        throw new RigFail('rig-backend-failed', `Rig backend failed: ${e.message}`, e.retryable);
      }
      if (e.t === 'progress') {
        yield { t: 'progress', jobId, at: at(), step: `predict:${e.step}`, done: 2, total: 4 };
      } else if (e.t === 'warn') {
        yield { t: 'warn', jobId, at: at(), code: e.code, message: e.message };
      }
    }

    const skeletonPath = `${opts.outDir}/${RIG_SKELETON_FILE}`;
    const weightsPath = `${opts.outDir}/${RIG_WEIGHTS_FILE}`;
    let skeleton: RigSkeleton;
    try {
      skeleton = parseWith(
        RigSkeletonSchema,
        JSON.parse(await Deno.readTextFile(skeletonPath)),
        'RigSkeleton',
      );
    } catch (err) {
      throw new RigFail(
        'rig-invalid-output',
        `The rig backend did not produce a readable ${RIG_SKELETON_FILE}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!skeleton.semanticNames) {
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'rig-generic-names',
        message:
          `The predicted skeleton has positional joint names (bone_0, bone_1, ...), so name-based ` +
          `tools - retarget profiles, animation packs - cannot map it. It will still bake.`,
      };
    }
    if (skeleton.validation.retries > 0) {
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'rig-retried',
        message: `The backend produced invalid weights and was retried on a fresh seed ` +
          `(${skeleton.validation.retries}x). The rig is usable but the result is not the ` +
          `seed you asked for.`,
      };
    }

    // 3. apply — core builds the skin
    const riggedPath = `${opts.outDir}/rigged.glb`;
    let applied;
    try {
      applied = await applyRig({ meshPath, skeletonPath, weightsPath, outPath: riggedPath });
    } catch (err) {
      throw new RigFail(
        'rig-apply-failed',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (applied.zeroWeightVertices > 0) {
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'rig-zero-weight-vertices',
        message: `${applied.zeroWeightVertices} vertices had no joint influence and were bound ` +
          `rigidly to the root - they will not deform with the body.`,
      };
    }
    yield { t: 'progress', jobId, at: at(), step: 'apply', done: 3, total: 4 };

    // 4. tier-1 nudges, on the rigged file (no re-predict needed)
    const edits = opts.rerunWithHints ? [] : (opts.edits ?? []);
    if (edits.length > 0) {
      const editResult = applyJointEdits(skeleton, edits);
      for (const unknown of editResult.unknownJoints) {
        yield {
          t: 'warn',
          jobId,
          at: at(),
          code: 'unknown-joint',
          message: `No joint named "${unknown}" in this rig, so that edit did nothing. ` +
            `Joint names: ${skeleton.joints.slice(0, 8).map((j) => j.name).join(', ')}...`,
        };
      }
      for (const missing of editResult.missingPartners) {
        yield {
          t: 'warn',
          jobId,
          at: at(),
          code: 'missing-side-partner',
          message: `"${missing}" was edited with mirroring on, but this rig has no side partner ` +
            `for it - only the named joint moved.`,
        };
      }
      const editedPath = `${opts.outDir}/rigged-edited.glb`;
      await applyEditsToRiggedGlb(riggedPath, editedPath, skeleton, editResult.skeleton);
      await Deno.rename(editedPath, riggedPath);
      await Deno.writeTextFile(
        skeletonPath,
        JSON.stringify(editResult.skeleton, null, 2) + '\n',
      );
      skeleton = editResult.skeleton;
    }

    yield { t: 'artifact', jobId, at: at(), kind: 'rig-model', path: riggedPath };
    yield { t: 'artifact', jobId, at: at(), kind: 'rig-skeleton', path: skeletonPath };

    // 5. does it actually deform?
    let flaggedJoints: string[] = [];
    if (!opts.skipDeformCheck) {
      const report = await deformCheck({ riggedPath, outDir: opts.outDir });
      flaggedJoints = report.flaggedJoints;
      yield {
        t: 'artifact',
        jobId,
        at: at(),
        kind: 'rig-deform-report',
        path: `${opts.outDir}/deform-report.json`,
      };
      if (flaggedJoints.length > 0) {
        const detail = report.joints
          .filter((j) => j.flags.length > 0)
          .slice(0, 6)
          .map((j) => `${j.joint} (${j.flags.join('/')})`)
          .join(', ');
        yield {
          t: 'warn',
          jobId,
          at: at(),
          code: 'deform-flagged',
          message: `${flaggedJoints.length} joints look wrong under test poses: ${detail}. ` +
            `See deform-report.json; \`rig --edits\` can nudge them.`,
        };
      }
    }
    yield { t: 'progress', jobId, at: at(), step: 'deform', done: 4, total: 4 };

    // 6. record the rig in the character, as a journaled patch — which is what
    // makes `spritebook undo` work on a repair (P3-T3 acceptance). Optional:
    // `rig` is usable on a bare glb with no character at all, and that is
    // deliberate (a user trying the tool out has no workspace yet).
    if (opts.workspace) {
      const rigState: RigState = {
        track: 'B',
        backend: { modelId: backend, version: skeleton.backend.version },
        skeletonProfile: 'generic',
        jointCount: skeleton.joints.length,
        jointEdits: edits,
        orientationFixes: fixes,
        // the user has not looked at it yet; `accepted` is theirs to set
        accepted: false,
      };

      // The rigged bytes BECOME the character's mesh, the way a Track A fit's
      // do (fitjob.ts). Recording the RigState alone left the manifest
      // describing a skeleton `canonical/model.glb` did not have, and a
      // character in that state is not merely untidy: `bake --clips` fails at
      // retarget with `target skeleton is missing the hips joint` immediately
      // after a rig that reported success, a bone mask has no skeleton to
      // resolve regions against, and the bake key hashes a RigState absent from
      // the bytes it keys. Track A REPLACES the body; Track B skins the same
      // vertices, so the canonical mesh becomes its own skinned self — the
      // safer of the two promotions.
      const paths = workspacePaths(opts.workspace);
      // heightM is NOT re-stated: rigging adds a skeleton to the vertices it
      // was given and does not change how tall the character stands, so
      // carrying the pick's height forward is the truthful move
      const promotion = await prepareCanonicalPromotion(opts.workspace, riggedPath);
      if (!promotion.ready && promotion.reason === 'io') {
        throw new RigFail(
          'rig-not-promoted',
          `Output was retained but could not be accepted: ${promotion.error.message}`,
        );
      }
      if (!promotion.ready) {
        yield {
          t: 'warn',
          jobId,
          at: at(),
          code: 'rig-not-promoted',
          message: 'This workspace has no picked canonical mesh, so the rigged model was left at ' +
            `${riggedPath} instead of becoming canonical/model.glb. Run \`spritebook pick\` ` +
            'first if you meant this rig to become the character.',
        };
      }

      try {
        // ONE patch: the rig and the hash of the bytes it produced. Journaled
        // apart, a single undo would restore the pre-rig RigState while
        // canonical/model.glb still held the rigged mesh.
        await setRigState(opts.workspace, rigState, {
          ...(promotion.ready ? { canonicalSource: promotion.canonicalSource } : {}),
          ...(promotion.ready && promotion.meshRepin ? { canonicalMesh: promotion.meshRepin } : {}),
        });
        if (promotion.ready) {
          yield {
            t: 'artifact',
            jobId,
            at: at(),
            kind: 'canonical-model',
            path: paths.canonicalModel,
          };
        }
        yield {
          t: 'artifact',
          jobId,
          at: at(),
          kind: 'character-manifest',
          path: `${opts.workspace}/${MANIFEST_FILE}`,
        };
      } catch (err) {
        throw new RigFail(
          'rig-not-recorded',
          `Output files were retained, but the character was not updated: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    yield {
      t: 'done',
      jobId,
      at: at(),
      wallTimeS: Number(((performance.now() - t0) / 1000).toFixed(3)),
    };
  } catch (err) {
    const fail = err instanceof RigFail
      ? err
      : new RigFail('rig-failed', err instanceof Error ? err.message : String(err));
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: fail.code,
      message: fail.message,
      retryable: fail.retryable,
    };
  } finally {
    await session?.dispose();
    // on every exit path, including a throw mid-prediction: a claim that
    // outlives its job shrinks the machine's budget until its heartbeat lapses
    await lease?.release();
  }
}

export function runRigJob(opts: RigJobOptions): AsyncIterable<JobEvent> {
  return workspaceJob(opts.workspace, () => executeRigJob(opts));
}
