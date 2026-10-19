import { promises as fs } from 'node:fs';
import { workspaceJob } from '@spritebook/core';
/**
 * The Track A `fit` job (P3-T4): fit the ONE canonical rigged body onto a
 * generated mesh, as a JobEvent stream like every other verb. job.ts (the
 * Track B rig job) is the pattern of record; this wrapper keeps its event
 * discipline and swaps the middle out for fit.ts's pure arithmetic — no
 * sidecar, no GPU, no backend process, so most of that job's failure modes
 * simply do not exist here.
 *
 * What this wrapper owns, beyond calling fitCanonicalBody:
 *
 *   - the body dir is validated FIRST, so a missing or malformed bundle is an
 *     actionable error event naming the exact file, not a stack trace from
 *     the middle of the fit;
 *   - a torn fit is a WARN, never an error — the maintainer's explicit call.
 *     Stray joints and unreached vertices are facts about a fit that still
 *     produced an openable glb, and opening that file is how anyone diagnoses
 *     the tear. Failing the job would delete the evidence, and would teach a
 *     roster script to treat "imperfect" as "absent";
 *   - with a workspace, the fit lands as ONE journaled RigState patch, with
 *     acceptance failure is terminal, with intermediate output retained.
 */
import type { CanonicalBody, JobEvent, RigState } from '@spritebook/schema';
import {
  CANONICAL_BODY_FILE,
  CANONICAL_BODY_MANIFEST,
  CanonicalBodySchema,
  MANIFEST_FILE,
  parseWith,
} from '@spritebook/schema';
import { setRigState, workspacePaths } from '@spritebook/core';
import { fitCanonicalBody, type FitReport } from './fit.ts';
import { prepareCanonicalPromotion } from './promote.ts';

export interface FitJobOptions {
  jobId: string;
  /** the canonical body bundle: a dir holding body.glb + body.json */
  bodyDir: string;
  /** the generated mesh whose shape the body takes */
  targetPath: string;
  /** fitted.glb and fit-report.json land here */
  outDir: string;
  /** declared standing height of the target, metres (see fit.ts) */
  heightM?: number;
  /** character workspace; when given, the fit is recorded as a journaled
   * RigState patch so `spritebook undo` can take it back */
  workspace?: string;
}

/** Above this share of body vertices left unprojected, the fit warns. */
export const UNPROJECTED_WARN_FRACTION = 0.05;

class FitFail extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

/**
 * Run one Track A fit. Event codes: fit-body-invalid, fit-failed, fit-not-recorded (errors);
 * fit-stray-joints, fit-unprojected (warns — a torn fit is
 * reported, never fatal).
 */
async function* executeFitJob(opts: FitJobOptions): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = opts.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  try {
    // the body bundle first, so a bad --body answers with the file that
    // disappointed before any work is spent on the target
    const bodyDir = opts.bodyDir.replace(/[\\/]+$/, '');
    const bodyPath = `${bodyDir}/${CANONICAL_BODY_FILE}`;
    const bodyManifestPath = `${bodyDir}/${CANONICAL_BODY_MANIFEST}`;
    let manifestText: string;
    try {
      manifestText = await fs.readFile(bodyManifestPath, 'utf8');
    } catch {
      throw new FitFail(
        'fit-body-invalid',
        `No canonical body manifest at "${bodyManifestPath}" - a body dir holds ` +
          `${CANONICAL_BODY_FILE} + ${CANONICAL_BODY_MANIFEST} as one bundle (the bundled ` +
          `bodies live in packages/rig/bodies/; buildCanonicalBody writes new ones)`,
      );
    }
    let body: CanonicalBody;
    try {
      body = parseWith(
        CanonicalBodySchema,
        JSON.parse(manifestText),
        `canonical body manifest "${bodyManifestPath}"`,
      );
    } catch (err) {
      throw new FitFail(
        'fit-body-invalid',
        `"${bodyManifestPath}" is not a canonical body manifest: ${
          err instanceof Error ? err.message : String(err)
        } - rebuild the body dir with buildCanonicalBody`,
      );
    }
    try {
      await fs.stat(bodyPath);
    } catch {
      throw new FitFail(
        'fit-body-invalid',
        `The manifest at "${bodyManifestPath}" is valid but the body itself is missing at ` +
          `"${bodyPath}" - the two ship as one bundle; re-copy the body dir or rebuild it`,
      );
    }

    await fs.mkdir(opts.outDir, { recursive: true });
    const fittedPath = `${opts.outDir}/fitted.glb`;
    let report: FitReport;
    try {
      report = await fitCanonicalBody({
        bodyPath,
        bodyManifestPath,
        targetPath: opts.targetPath,
        outPath: fittedPath,
        ...(opts.heightM !== undefined ? { heightM: opts.heightM } : {}),
      });
    } catch (err) {
      throw new FitFail('fit-failed', err instanceof Error ? err.message : String(err));
    }
    yield { t: 'progress', jobId, at: at(), step: 'fit', done: 1, total: 2 };

    const reportPath = `${opts.outDir}/fit-report.json`;
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    yield { t: 'artifact', jobId, at: at(), kind: 'fit-model', path: fittedPath };
    yield { t: 'artifact', jobId, at: at(), kind: 'fit-report', path: reportPath };

    // Stray joints and a heavy unprojected count WARN and never fail — the
    // maintainer's explicit instruction. fit.ts already chose to report a
    // tear rather than throw, because the written glb IS the diagnostic;
    // this wrapper keeps that stance at the event level, where an `error`
    // would read as "no character" when the truth is "present, imperfect,
    // and worth a look".
    if (report.strayJoints.length > 0) {
      const named = report.strayJoints.slice(0, 8).join(', ');
      const rest = report.strayJoints.length - 8;
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'fit-stray-joints',
        message:
          `${report.strayJoints.length} joint${
            report.strayJoints.length === 1 ? '' : 's'
          } landed outside the target mesh: ${named}${rest > 0 ? ` (+${rest} more)` : ''}. ` +
          `Those body parts found no matching surface on the target (fused arms, missing ` +
          `fingers and held props are the usual causes), so the skin there will not follow a ` +
          `silhouette that does not exist. The fit is still on disk - open ${fittedPath} to ` +
          `judge it; a cleaner target mesh or an explicit height often repairs it.`,
      };
    }
    const unprojectedShare = report.unprojectedVertices / body.vertexCount;
    if (unprojectedShare > UNPROJECTED_WARN_FRACTION) {
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'fit-unprojected',
        message: `${report.unprojectedVertices} of ${body.vertexCount} body vertices ` +
          `(${(unprojectedShare * 100).toFixed(1)}%) were farther from the target than the ` +
          `projection falloff allows, so they kept their scaled positions instead of snapping ` +
          `to the surface. Expect the silhouette to drift wherever the generated mesh has no ` +
          `matching part; the counts are in ${reportPath}.`,
      };
    }
    yield { t: 'progress', jobId, at: at(), step: 'validate', done: 2, total: 2 };

    // record the fit in the character, as a journaled patch — same seam and
    // same optionality as runRigJob (a user trying the fit on a bare glb has
    // no workspace, and that is fine)
    if (opts.workspace) {
      // The fitted body IS the character's mesh from here on: Track A's whole
      // claim is that the roster shares this body, so leaving fitted.glb in an
      // output dir while canonical/model.glb still held the unfitted generated
      // mesh made every downstream verb (identity, bake) operate on the wrong
      // geometry - and a decal aimed at a region would find no skeleton to own
      // it. Promote the bytes, then pin them in the SAME patch as the rig.
      const paths = workspacePaths(opts.workspace);
      // the fit REPORTS the height it fitted to, so the re-pin carries it; no
      // need to re-measure, and a rig (which does not change height) passes none
      const promotion = await prepareCanonicalPromotion(opts.workspace, fittedPath, report.heightM);
      const promoted = promotion.ready;
      const meshRepin = promotion.ready ? promotion.meshRepin : undefined;
      if (!promotion.ready && promotion.reason === 'io') {
        throw new FitFail(
          'fit-not-promoted',
          `Output was retained but could not be accepted: ${promotion.error.message}`,
        );
      }
      if (!promotion.ready) {
        yield {
          t: 'warn',
          jobId,
          at: at(),
          code: 'fit-not-promoted',
          message: 'This workspace has no picked canonical mesh, so the fitted body was left in ' +
            `${fittedPath} instead of becoming canonical/model.glb. Run \`spritebook pick\` ` +
            'first if you meant this fit to become the character.',
        };
      }

      // No `backend` field, deliberately: the fit is deterministic core code
      // (fit.ts arithmetic), not an AI backend — there is no model id or
      // version to record, and inventing one would be provenance fiction.
      const rigState: RigState = {
        track: 'A',
        skeletonProfile: 'ual-humanoid',
        jointCount: body.jointCount,
        jointEdits: [],
        orientationFixes: [],
        // the body's sockets become the character's: Track A shares ONE
        // skeleton, so "hand-r" means the same place on every character on
        // this body. Without them `identity --attachments` has nothing to
        // resolve against and refuses with "available sockets: (none)".
        ...(body.sockets && body.sockets.length > 0 ? { sockets: body.sockets } : {}),
        // the user has not looked at it yet; `accepted` is theirs to set
        accepted: false,
      };
      try {
        await setRigState(opts.workspace, rigState, {
          ...(promotion.ready ? { canonicalSource: promotion.canonicalSource } : {}),
          ...(meshRepin ? { canonicalMesh: meshRepin } : {}),
        });
        if (promoted) {
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
        if ((err as { code?: string }).code === 'rig-unchanged') {
          yield {
            t: 'warn',
            jobId,
            at: at(),
            code: 'rig-unchanged',
            message: 'Output matches the accepted rig; no change to record.',
          };
        } else {
          throw new FitFail(
            'fit-not-recorded',
            `Output files were retained, but the character was not updated: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    yield {
      t: 'done',
      jobId,
      at: at(),
      wallTimeS: Number(((performance.now() - t0) / 1000).toFixed(3)),
    };
  } catch (err) {
    const fail = err instanceof FitFail
      ? err
      : new FitFail('fit-failed', err instanceof Error ? err.message : String(err));
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: fail.code,
      message: fail.message,
      retryable: fail.retryable,
    };
  }
}

export function runFitJob(opts: FitJobOptions): AsyncIterable<JobEvent> {
  return workspaceJob(opts.workspace, () => executeFitJob(opts));
}
