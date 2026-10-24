import { promises as fs } from 'node:fs';
import { workspaceJob } from '@spritebook/core';
/**
 * The `identity` job (P3-T4, Track A): decals, attachments and bone masks
 * applied to a character's PICKED canonical mesh, as a JobEvent stream like
 * every other verb. identity.ts owns the three passes and their correctness;
 * this wrapper owns the order they run in, the staging that keeps a half-done
 * run off the workspace, and the journaling that makes the result undoable.
 *
 * ## The stage order is load-bearing
 *
 *   1. bone mask   — it REPLACES geometry, deciding which body the character
 *                    even has; everything downstream must see the post-mask
 *                    body, not the one it just cut away.
 *   2. attachments — they PARENT rigid meshes to joints; running after the
 *                    mask means a prop hangs off the body the character
 *                    actually keeps (and is never confused with the skinned
 *                    geometry a mask selects by weight).
 *   3. decals      — they PAINT the final surface's texture; painting last
 *                    makes "the decal is on the character you ship" true by
 *                    construction rather than by coincidence of stage order.
 *
 * ## Reversibility (why rewriting canonical/model.glb in place is safe)
 *
 * Undo restores the MANIFEST: this job's whole effect is ONE journaled patch
 * with precomputed inverses — the identity records and the canonical mesh
 * re-pin together, because a single undo of "add the tattoo" must not leave a
 * manifest claiming no identity while pinning the tattooed bytes. The canonical
 * glb itself is not journaled and does not need to be, because it is
 * RE-DERIVABLE: `results/<picked>/model.glb` is immutable (receipts are
 * append-only history, and `pick` copies rather than moves), so the byte
 * recovery path is pick again, then replay reprojection and the identity
 * layer that the restored manifest describes. Nothing here ever touches the
 * results dir. The stages also run file-to-file through temps in canonical/
 * and the final rename happens only after ALL of them succeeded, so a failed
 * run leaves canonical/model.glb byte-for-byte what it was.
 */
import { heightOf } from './pick.ts';
import type {
  AttachmentPlacement,
  BoneMask,
  CanonicalBody,
  DecalPlacement,
  JobEvent,
} from '@spritebook/schema';
import { CanonicalBodySchema, parseWith } from '@spritebook/schema';
import {
  type IdentityFields,
  readWorkspace,
  setIdentity,
  sha256Bytes,
  workspacePaths,
} from '@spritebook/core';
import { applyAttachments, applyBoneMask, compositeDecals } from './identity.ts';

export interface IdentityJobOptions {
  jobId: string;
  workspace: string;
  /** the canonical body manifest (body.json), for region lookup — required
   * when a bone mask is given or a decal is placed by region name */
  bodyManifestPath?: string;
  decals?: DecalPlacement[];
  attachments?: AttachmentPlacement[];
  boneMask?: BoneMask;
}

class IdentityFail extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

/**
 * Run one identity pass. Event codes: identity-no-op, identity-not-picked,
 * identity-body-required, identity-body-invalid, identity-no-rig,
 * identity-failed (errors). Stages emit progress steps `bone-mask`,
 * `attachments`, `decals` (whichever were requested), then `record`.
 */
async function* executeIdentityJob(opts: IdentityJobOptions): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = opts.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  const tmp: string[] = [];
  // reports for stages that ran; discarded with their output if a LATER stage
  // fails, because a report describing geometry the workspace threw away is
  // not evidence, it is a lie the next run has to argue with
  const reports: string[] = [];
  let committed = false;
  try {
    const decals = opts.decals ?? [];
    const attachments = opts.attachments ?? [];
    const mask = opts.boneMask ?? {};
    const maskRegions = Object.keys(mask);
    if (decals.length === 0 && attachments.length === 0 && maskRegions.length === 0) {
      throw new IdentityFail(
        'identity-no-op',
        'Nothing to apply - pass at least one decal, attachment or bone-mask region. An empty ' +
          'identity pass would journal a no-op patch, and an undo stack full of no-ops is an ' +
          'undo stack nobody trusts (receipts.ts refuses them for the same reason).',
      );
    }

    const paths = workspacePaths(opts.workspace);
    const manifest = await readWorkspace(opts.workspace);
    const canonicalMesh = manifest.canonicalMesh;
    if (canonicalMesh === undefined || manifest.generation.pickedResultId === undefined) {
      throw new IdentityFail(
        'identity-not-picked',
        'This character has no picked canonical mesh yet - run `spritebook pick` first: ' +
          'identity operates on canonical/model.glb, and picking is what writes it.',
      );
    }
    try {
      await fs.stat(paths.canonicalModel);
    } catch {
      throw new IdentityFail(
        'identity-not-picked',
        `The manifest names picked result "${manifest.generation.pickedResultId}" but ` +
          `"${paths.canonicalModel}" is missing - re-run \`spritebook pick\` (results/ still ` +
          'holds the immutable original).',
      );
    }

    // the body manifest, the moment any placement speaks in region names
    const needsBody = maskRegions.length > 0 || decals.some((d) => d.region !== undefined);
    let body: CanonicalBody | undefined;
    if (opts.bodyManifestPath !== undefined) {
      let text: string;
      try {
        text = await fs.readFile(opts.bodyManifestPath, 'utf8');
      } catch (err) {
        throw new IdentityFail(
          'identity-body-invalid',
          `Cannot read the canonical body manifest at "${opts.bodyManifestPath}" ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
      }
      try {
        body = parseWith(
          CanonicalBodySchema,
          JSON.parse(text),
          `canonical body manifest "${opts.bodyManifestPath}"`,
        );
      } catch (err) {
        throw new IdentityFail(
          'identity-body-invalid',
          err instanceof Error ? err.message : String(err),
        );
      }
    } else if (needsBody) {
      throw new IdentityFail(
        'identity-body-required',
        'A bone mask - and any decal placed by region name - resolves regions through the ' +
          'canonical body manifest; pass bodyManifestPath (the body.json of the body this ' +
          'character was fitted to), or place decals with an explicit uvRect.',
      );
    }

    // setIdentity journals a bone mask into rig.boneMask, which requires a
    // rig — refused HERE, before any geometry is cut, because refusing at the
    // journaling step would come after the work was already spent
    if (maskRegions.length > 0 && manifest.rig === undefined) {
      throw new IdentityFail(
        'identity-no-rig',
        'A bone mask replaces regions of a RIGGED body, and this character has no rig yet - ' +
          'run `spritebook fit` (Track A) or `spritebook rig` (Track B) first.',
      );
    }

    // the stages, in the load-bearing order (module header), each one
    // file-to-file into a temp so a failure anywhere leaves the workspace's
    // canonical mesh exactly as it was
    const stages: {
      step: string;
      run: (modelPath: string, outPath: string) => Promise<unknown>;
    }[] = [];
    if (maskRegions.length > 0) {
      stages.push({
        step: 'bone-mask',
        run: (modelPath, outPath) => applyBoneMask({ modelPath, mask, body: body!, outPath }),
      });
    }
    if (attachments.length > 0) {
      stages.push({
        step: 'attachments',
        run: (modelPath, outPath) =>
          applyAttachments({
            modelPath,
            attachments,
            // sockets live in RigState; a rig with none makes applyAttachments
            // list "(none)", which already names the actual problem
            sockets: manifest.rig?.sockets ?? [],
            outPath,
          }),
      });
    }
    if (decals.length > 0) {
      stages.push({
        step: 'decals',
        run: (modelPath, outPath) =>
          compositeDecals({ modelPath, decals, outPath, ...(body ? { body } : {}) }),
      });
    }

    const root = opts.workspace.replace(/[\\/]+$/, '');
    const total = stages.length + 1; // + the record step (re-pin + journal)
    let done = 0;
    let current = paths.canonicalModel;
    for (const stage of stages) {
      const outPath = `${paths.canonicalDir}/identity-${crypto.randomUUID()}-${stage.step}.tmp.glb`;
      tmp.push(outPath);
      let report: unknown;
      try {
        report = await stage.run(current, outPath);
      } catch (err) {
        throw new IdentityFail(
          'identity-failed',
          `Applying ${stage.step} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      current = outPath;
      const reportPath = `${root}/identity-${stage.step}-report.json`;
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      done++;
      // a stage's non-fatal notes are worth an event, not just a line in a
      // file nobody opens on a green run (an ambiguous decal atlas is
      // invisible in the output, so the warning IS the only signal)
      const notes = (report as { warnings?: unknown })?.warnings;
      if (Array.isArray(notes)) {
        for (const note of notes) {
          yield {
            t: 'warn',
            jobId,
            at: at(),
            code: `identity-${stage.step}`,
            message: String(note),
          };
        }
      }
      yield { t: 'progress', jobId, at: at(), step: stage.step, done, total };
      yield {
        t: 'artifact',
        jobId,
        at: at(),
        kind: `identity-${stage.step}-report`,
        path: reportPath,
      };
    }

    // Core retains both revisions and publishes these staged bytes with the manifest patch.
    const bytes = new Uint8Array(await fs.readFile(current));
    const gltfSha256 = await sha256Bytes(bytes);
    let meshRepin: { gltfSha256: string; heightM?: number } | undefined;
    if (gltfSha256 !== canonicalMesh.gltfSha256) {
      const heightM = await heightOf(bytes);
      meshRepin = { gltfSha256, ...(heightM > 0 ? { heightM } : {}) };
    }

    // the records: what the job APPLIED, in the manifest's own vocabulary
    // (DecalPlacement/AttachmentPlacement are job inputs; DetailLayer/
    // Attachment are the character's declarative statement of what it has)
    const fields: IdentityFields = {};
    if (decals.length > 0) {
      fields.detailLayers = decals.map((d) => ({
        id: d.id,
        uvDecalPng: d.pngPath,
        ...(d.region !== undefined ? { region: d.region } : {}),
      }));
    }
    if (attachments.length > 0) {
      const recorded: NonNullable<IdentityFields['attachments']> = [];
      for (const a of attachments) {
        // the sha pins WHICH mesh was attached, the way canonicalMesh pins
        // the picked bytes — provenance, not a path that can go stale
        recorded.push({
          id: a.id,
          socketId: a.socketId,
          meshSha256: await sha256Bytes(new Uint8Array(await fs.readFile(a.meshPath))),
        });
      }
      fields.attachments = recorded;
    }
    if (maskRegions.length > 0) fields.boneMask = mask;
    if (meshRepin) fields.canonicalMesh = meshRepin;
    await setIdentity(opts.workspace, fields, { canonicalSource: current });
    committed = true; // the reports now describe the workspace, so they stay
    done++;
    yield { t: 'progress', jobId, at: at(), step: 'record', done, total };

    yield { t: 'artifact', jobId, at: at(), kind: 'canonical-model', path: paths.canonicalModel };
    yield { t: 'artifact', jobId, at: at(), kind: 'character-manifest', path: paths.manifest };
    yield {
      t: 'done',
      jobId,
      at: at(),
      wallTimeS: Number(((performance.now() - t0) / 1000).toFixed(3)),
    };
  } catch (err) {
    const fail = err instanceof IdentityFail
      ? err
      : new IdentityFail('identity-failed', err instanceof Error ? err.message : String(err));
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: fail.code,
      message: fail.message,
      retryable: fail.retryable,
    };
  } finally {
    if (!committed) tmp.push(...reports);
    for (const p of tmp) {
      try {
        await fs.rm(p);
      } catch {
        // renamed into place, or never written — either way there is nothing
        // left to clean
      }
    }
  }
}

export function runIdentityJob(opts: IdentityJobOptions): AsyncIterable<JobEvent> {
  return workspaceJob(opts.workspace, () => executeIdentityJob(opts));
}
