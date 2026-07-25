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
 *     runRigJob's warn-on-recording-failure discipline: the fit is on disk,
 *     and failing the job over bookkeeping would throw away real work.
 */
import type { CanonicalBody, JobEvent, RigState } from '@spritebook/schema';
import {
  CANONICAL_BODY_FILE,
  CANONICAL_BODY_MANIFEST,
  CanonicalBodySchema,
  MANIFEST_FILE,
  parseWith,
} from '@spritebook/schema';
import { readWorkspace, setRigState, workspacePaths } from '@spritebook/core';
import { fitCanonicalBody, type FitReport } from './fit.ts';

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
 * Run one Track A fit. Event codes: fit-body-invalid, fit-failed (errors);
 * fit-stray-joints, fit-unprojected, fit-not-recorded (warns — a torn fit is
 * reported, never fatal).
 */
export async function* runFitJob(opts: FitJobOptions): AsyncIterable<JobEvent> {
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
      manifestText = await Deno.readTextFile(bodyManifestPath);
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
      await Deno.stat(bodyPath);
    } catch {
      throw new FitFail(
        'fit-body-invalid',
        `The manifest at "${bodyManifestPath}" is valid but the body itself is missing at ` +
          `"${bodyPath}" - the two ship as one bundle; re-copy the body dir or rebuild it`,
      );
    }

    await Deno.mkdir(opts.outDir, { recursive: true });
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
    await Deno.writeTextFile(reportPath, JSON.stringify(report, null, 2) + '\n');
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
      let meshRepin: { gltfSha256: string; heightM?: number } | undefined;
      let promoted = false;
      try {
        const manifest = await readWorkspace(opts.workspace);
        if (manifest.canonicalMesh === undefined) {
          yield {
            t: 'warn',
            jobId,
            at: at(),
            code: 'fit-not-promoted',
            message:
              'This workspace has no picked canonical mesh, so the fitted body was left in ' +
              `${fittedPath} instead of becoming canonical/model.glb. Run \`spritebook pick\` ` +
              'first if you meant this fit to become the character.',
          };
        } else {
          const bytes = await Deno.readFile(fittedPath);
          await Deno.mkdir(paths.canonicalDir, { recursive: true });
          await Deno.writeFile(paths.canonicalModel, bytes);
          promoted = true;
          const gltfSha256 = await sha256Hex(bytes);
          if (gltfSha256 !== manifest.canonicalMesh.gltfSha256) {
            // the fit REPORTS the height it fitted to; no need to re-measure
            meshRepin = { gltfSha256, heightM: report.heightM };
          }
        }
      } catch (err) {
        yield {
          t: 'warn',
          jobId,
          at: at(),
          code: 'fit-not-promoted',
          message: `The fit is on disk at ${fittedPath} but could not become the workspace's ` +
            `canonical mesh: ${err instanceof Error ? err.message : String(err)}`,
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
        // the user has not looked at it yet; `accepted` is theirs to set
        accepted: false,
      };
      try {
        await setRigState(opts.workspace, rigState, {
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
        // the fit itself succeeded and its files are on disk; failing the job
        // now would throw away real work over bookkeeping (job.ts discipline)
        yield {
          t: 'warn',
          jobId,
          at: at(),
          code: 'fit-not-recorded',
          message: `The fit is on disk but could not be recorded in the character: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
