/**
 * `spritebook pick` — promote one generation result to THE canonical mesh,
 * optionally repainting its texture from the source image first (P3-T2).
 *
 * Picking writes `canonical/model.glb`: one stable path every downstream verb
 * (`rig`, `bake`) can name, so nothing downstream has to know which result id
 * won. The copy is deliberate rather than a symlink — Windows symlinks need
 * privileges we should not require, and a bake reading a dangling link is a
 * worse failure than a duplicated 2 MB file.
 *
 * With `--reproject` the source image is painted back onto the picked mesh
 * (see reproject.ts) BEFORE the canonical hash is recorded, so the manifest's
 * `canonicalMesh.gltfSha256` always pins the bytes that are actually on disk.
 *
 * ## One step, one patch, one undo
 *
 * The whole verb — promote, optionally repaint, record — is ONE journaled
 * patch, the shape identityjob.ts and the Track A fit already use. Splitting
 * the re-pin off into a second patch made `spritebook undo` after
 * `pick --reproject` pop only half the step, leaving a manifest that pinned
 * the pre-reproject sha for bytes that had been repainted.
 *
 * The stages run file-to-file through temps in canonical/ and the rename into
 * `canonical/model.glb` happens only once every stage succeeded, so the bytes
 * and the manifest change together and a failed reprojection leaves the
 * workspace exactly as it was. The glb is not journaled and does not need to
 * be: `results/<id>/model.glb` is immutable (pick copies, never moves), so the
 * byte recovery path is always to pick again.
 */
import { CANONICAL_MODEL, type JobEvent } from '@spritebook/schema';
import {
  pickResult,
  readWorkspace,
  resultPaths,
  sourceImagePath,
  workspacePaths,
} from '@spritebook/core';
import { loadCatalog } from '@spritebook/registry';
import { NodeIO } from '@gltf-transform/core';
import { reprojectTexture } from './reproject.ts';

export interface PickJobOptions {
  jobId: string;
  workspace: string;
  /** result id to promote (`r1`, `r2`, ...) */
  resultId: string;
  /** repaint the texture from the source image before recording the hash */
  reproject?: boolean;
  /** source image override; defaults to the manifest's stored source */
  imagePath?: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Standing height in metres from the mesh's Y extent (the D-012 convention). */
export async function heightOf(bytes: Uint8Array): Promise<number> {
  const doc = await new NodeIO().readBinary(bytes);
  let min = Infinity, max = -Infinity;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const arr = pos.getArray()!;
      for (let i = 1; i < arr.length; i += 3) {
        min = Math.min(min, arr[i]);
        max = Math.max(max, arr[i]);
      }
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? Number((max - min).toFixed(6)) : 0;
}

/**
 * Promote a result. Event codes: unknown-result, discarded-result,
 * missing-model, no-source, reproject-failed, picked-multi-body (warn).
 */
export async function* runPickJob(opts: PickJobOptions): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = opts.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  const tmp: string[] = [];
  try {
    const manifest = await readWorkspace(opts.workspace);
    const receipt = manifest.generation.results.find((r) => r.id === opts.resultId);
    if (!receipt) {
      const ids = manifest.generation.results.map((r) => r.id).join(', ') || '(none yet)';
      throw Object.assign(
        new Error(`No result "${opts.resultId}" in this character - results: ${ids}`),
        { code: 'unknown-result' },
      );
    }
    if (receipt.discarded) {
      throw Object.assign(
        new Error(
          `Result "${opts.resultId}" was discarded; pick another or re-generate it`,
        ),
        { code: 'discarded-result' },
      );
    }

    const paths = workspacePaths(opts.workspace);
    const rp = resultPaths(opts.workspace, opts.resultId);
    const canonicalPath = `${paths.canonicalDir}/${CANONICAL_MODEL}`;
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(rp.model);
    } catch {
      throw Object.assign(
        new Error(
          `Result "${opts.resultId}" has no canonical model at ${rp.model} - re-run \`gen\``,
        ),
        { code: 'missing-model' },
      );
    }
    await Deno.mkdir(paths.canonicalDir, { recursive: true });

    // `pick` promotes what it was ASKED to promote — it does not silently
    // choose a different result — but it is the last point before ~90 s of
    // rigging where the roster is still visible, so it says when a connected
    // sibling exists. `gen` records `bodies` per result exactly for this: the
    // same image at different seeds lands on different answers (robot-astro:
    // two bodies at seed 7, one at 100 and 201), so "generate a few and take
    // the connected one" is a real strategy and this is where it pays off.
    //
    // Absent `bodies` is UNKNOWN, not one: results generated before this was
    // measured carry nothing, and treating them as connected would recommend
    // a sibling on no evidence.
    const bodies = receipt.output.bodies;
    if (bodies !== undefined && bodies !== 1) {
      const connected = manifest.generation.results.filter((r) =>
        !r.discarded && r.id !== receipt.id && r.output.bodies === 1
      );
      const alt = connected.length > 0
        ? `${connected.length === 1 ? 'Result' : 'Results'} ${
          connected.map((r) => `"${r.id}"`).join(', ')
        } ` +
          `${connected.length === 1 ? 'is' : 'are'} a single body - ` +
          `\`spritebook pick --result ${connected[0].id}\` instead, if the silhouette suits you.`
        : `No sibling result here is a single body either, so this is not a pick to re-make - ` +
          `re-run \`gen\` at another seed, or join the pieces before rigging.`;
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'picked-multi-body',
        message: bodies === 0
          ? `Result "${receipt.id}" has NO body-sized piece - it is fragments, not a character. ` +
            alt
          : `Result "${receipt.id}" is ${bodies} DETACHED body-sized pieces. A rig predicts one ` +
            `skeleton for all of them, so the deform check will report tearing that no joint ` +
            `placement repairs. ${alt}`,
      };
    }

    const total = opts.reproject ? 3 : 2;

    // staged, not written straight to canonicalPath: the bytes and the
    // manifest have to change together, so nothing becomes canonical until
    // every stage of this verb has succeeded
    let staged = `${paths.canonicalDir}/pick-${opts.resultId}.tmp.glb`;
    tmp.push(staged);
    await Deno.writeFile(staged, bytes);
    yield { t: 'progress', jobId, at: at(), step: 'promote', done: 1, total };

    // texturedBy is a property of the JOB, so derive it from what the backend
    // declared it emits rather than guessing from the file
    let texturedBy: 'backend' | 'texture-substage' = 'backend';
    try {
      const catalog = await loadCatalog();
      const entry = catalog.models.find((m) => m.id === receipt.backend.modelId);
      const version = entry?.versions.find((v) => v.version === receipt.backend.version);
      if (version?.outputs?.texture === false) texturedBy = 'texture-substage';
    } catch {
      // a backend that has since left the catalog cannot change what already
      // ran; 'backend' is the honest default for a mesh that arrived textured
    }

    let reprojected = false;
    if (opts.reproject) {
      const image = opts.imagePath ?? sourceImagePath(opts.workspace, manifest);
      try {
        await Deno.stat(image);
      } catch {
        throw Object.assign(
          new Error(
            `Cannot reproject: the source image is missing at ${image} - pass --image explicitly`,
          ),
          { code: 'no-source' },
        );
      }
      const painted = `${paths.canonicalDir}/pick-${opts.resultId}-reprojected.tmp.glb`;
      tmp.push(painted);
      try {
        const stats = await reprojectTexture({
          modelPath: staged,
          imagePath: image,
          outPath: painted,
        });
        staged = painted;
        reprojected = true;
        yield {
          t: 'progress',
          jobId,
          at: at(),
          step: `reproject:${(stats.coverage * 100).toFixed(1)}%-painted`,
          done: 2,
          total: 3,
        };
        if (stats.coverage < 0.05) {
          yield {
            t: 'warn',
            jobId,
            at: at(),
            code: 'reproject-low-coverage',
            message:
              `Reprojection painted only ${(stats.coverage * 100).toFixed(1)}% of the texture. ` +
              `That usually means the mesh does not face the camera the source image implies, ` +
              `so most texels were back-facing or occluded and kept their generated color.`,
          };
        }
      } catch (err) {
        throw Object.assign(
          new Error(`Reprojection failed: ${err instanceof Error ? err.message : String(err)}`),
          { code: 'reproject-failed' },
        );
      }
    }

    // every stage succeeded: the staged file becomes THE canonical mesh in one
    // rename, and the manifest follows it in ONE patch. Both the promotion and
    // the re-pin land together, so `spritebook undo` after `pick --reproject`
    // pops the whole step instead of half of it.
    await Deno.rename(staged, canonicalPath);
    const finalBytes = await Deno.readFile(canonicalPath);
    await pickResult(opts.workspace, opts.resultId, {
      label: reprojected ? `Pick ${opts.resultId} (reprojected)` : `Pick ${opts.resultId}`,
      // the height is measured from the mesh: the receipt does not carry one,
      // and core refuses to invent it
      heightM: await heightOf(finalBytes),
      texturedBy,
      reprojected,
      // reprojection repaints the texture, so the receipt's hash describes
      // bytes that are no longer the canonical ones
      ...(reprojected ? { canonicalMesh: { gltfSha256: await sha256Hex(finalBytes) } } : {}),
    });
    yield { t: 'progress', jobId, at: at(), step: 'record', done: total, total };

    yield { t: 'artifact', jobId, at: at(), kind: 'canonical-model', path: canonicalPath };
    yield { t: 'artifact', jobId, at: at(), kind: 'character-manifest', path: paths.manifest };
    yield {
      t: 'done',
      jobId,
      at: at(),
      wallTimeS: Number(((performance.now() - t0) / 1000).toFixed(3)),
    };
  } catch (err) {
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: (err as { code?: string }).code ?? 'pick-failed',
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    };
  } finally {
    for (const path of tmp) {
      try {
        await Deno.remove(path);
      } catch {
        // renamed into place, or never written — either way there is nothing
        // left to clean
      }
    }
  }
}
