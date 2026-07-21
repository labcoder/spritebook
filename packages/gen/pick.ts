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
 */
import { CANONICAL_MODEL, type JobEvent } from '@spritebook/schema';
import {
  pickResult,
  readWorkspace,
  resultPaths,
  setCanonicalMesh,
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
async function heightOf(bytes: Uint8Array): Promise<number> {
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
 * missing-model, no-source, reproject-failed.
 */
export async function* runPickJob(opts: PickJobOptions): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = opts.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

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
    await Deno.writeFile(canonicalPath, bytes);
    yield {
      t: 'progress',
      jobId,
      at: at(),
      step: 'promote',
      done: 1,
      total: opts.reproject ? 3 : 2,
    };

    // journal the pick itself first, so the manifest names a picked result
    // even if reprojection then fails and the user retries with --reproject.
    // The height is measured from the mesh: the receipt does not carry one,
    // and core refuses to invent it.
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
    await pickResult(opts.workspace, opts.resultId, {
      label: `Pick ${opts.resultId}`,
      heightM: await heightOf(bytes),
      texturedBy,
    });

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
      try {
        const stats = await reprojectTexture({
          modelPath: canonicalPath,
          imagePath: image,
          outPath: canonicalPath,
        });
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

    // pickResult already recorded canonicalMesh for the promoted bytes, so
    // only reprojection has anything left to say — and when it does, the
    // manifest must follow the bytes that are ACTUALLY on disk now
    if (reprojected) {
      const finalBytes = await Deno.readFile(canonicalPath);
      await setCanonicalMesh(opts.workspace, {
        gltfSha256: await sha256Hex(finalBytes),
        heightM: await heightOf(finalBytes),
        reprojected: true,
      }, { label: `Reproject ${opts.resultId}` });
    }

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
  }
}
