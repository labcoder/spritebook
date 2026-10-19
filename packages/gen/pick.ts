import { promises as fs } from 'node:fs';
import { workspaceJob } from '@spritebook/core';
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
import { colorMatchTexture } from './colormatch.ts';

export interface PickJobOptions {
  jobId: string;
  workspace: string;
  /** result id to promote (`r1`, `r2`, ...) */
  resultId: string;
  /** FORCE reprojection — for a mesh-sourced character with an `--image`, or
   * any case where the default did not apply. Image-sourced characters
   * reproject by default (A3: face recovery on 3/3 subjects, no back damage),
   * so this flag is only needed to opt IN where the default is off. */
  reproject?: boolean;
  /** skip the DEFAULT reprojection for an image-sourced character */
  noReproject?: boolean;
  /** skip the DEFAULT colour-match pass (A2) — it otherwise runs for every
   * image-sourced character, reconciling the texture's colour statistics with
   * the source. Skipping is a choice worth recording, hence a flag and not an
   * option that must be asserted. Both fidelity passes off
   * (`--no-color-match --no-reproject`) is the plain byte-copy pick. */
  noColorMatch?: boolean;
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
async function* executePickJob(opts: PickJobOptions): AsyncIterable<JobEvent> {
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
      bytes = new Uint8Array(await fs.readFile(rp.model));
    } catch {
      throw Object.assign(
        new Error(
          `Result "${opts.resultId}" has no canonical model at ${rp.model} - re-run \`gen\``,
        ),
        { code: 'missing-model' },
      );
    }
    await fs.mkdir(paths.canonicalDir, { recursive: true });

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

    // colour-match runs BY DEFAULT for image-sourced characters: it is the
    // designed fix for "the texture's colours do not match the image I gave
    // you", and a default that must be asked for fixes nothing. A mesh-sourced
    // character has no image to match and never runs it.
    const wantColorMatch = manifest.source.kind === 'image' && opts.noColorMatch !== true;
    // Reprojection is a DEFAULT for image-sourced characters too (A3: it
    // returned the faces on 3/3 subjects with no back damage). `reproject`
    // stays as the explicit opt-IN for the cases the default excludes — a
    // mesh-sourced character handed an `--image`.
    const wantReproject = manifest.source.kind === 'image'
      ? opts.noReproject !== true
      : opts.reproject === true;
    const total = 2 + (wantColorMatch ? 1 : 0) + (wantReproject ? 1 : 0);
    let done = 0;

    // staged, not written straight to canonicalPath: the bytes and the
    // manifest have to change together, so nothing becomes canonical until
    // every stage of this verb has succeeded
    let staged = `${paths.canonicalDir}/pick-${crypto.randomUUID()}-${opts.resultId}.tmp.glb`;
    tmp.push(staged);
    await fs.writeFile(staged, bytes);
    yield { t: 'progress', jobId, at: at(), step: 'promote', done: ++done, total };

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

    // Both fidelity passes condition on the SAME image, resolved once — and its
    // hash is pinned in the patch, because `--image` overrides previously went
    // unrecorded and "re-run exactly this" was unanswerable for such a pick.
    const fidelityImage = opts.imagePath ?? sourceImagePath(opts.workspace, manifest);
    let imageSha: string | undefined;

    let colorMatched = false;
    if (wantColorMatch) {
      let readable = true;
      try {
        await fs.stat(fidelityImage);
      } catch {
        readable = false;
      }
      if (!readable && opts.imagePath !== undefined) {
        // an EXPLICIT image that does not exist is an error, not a soft skip
        throw Object.assign(
          new Error(`Cannot color-match: no image at ${fidelityImage}`),
          { code: 'no-source' },
        );
      }
      if (!readable) {
        yield {
          t: 'warn',
          jobId,
          at: at(),
          code: 'color-match-skipped',
          message: `the stored source image is missing at ${fidelityImage}, so the default ` +
            `colour-match pass did not run. The texture keeps the backend's own colours.`,
        };
      } else {
        const matched =
          `${paths.canonicalDir}/pick-${crypto.randomUUID()}-${opts.resultId}-matched.tmp.glb`;
        tmp.push(matched);
        const stats = await colorMatchTexture({
          modelPath: staged,
          imagePath: fidelityImage,
          outPath: matched,
        });
        if (stats.skipped === 'low-chroma') {
          // the pass declined: a near-monochrome source has no palette worth
          // matching to, and transferring its statistics would crush the
          // texture toward grey. The STAGED file stays the untouched original —
          // the skip path's output is a re-serialization, not the same bytes.
          yield {
            t: 'warn',
            jobId,
            at: at(),
            code: 'color-match-skipped',
            message: `the source image is nearly monochrome (mean chroma ` +
              `${stats.sourceChroma.toFixed(3)} < 0.02), so colour-match declined to run - ` +
              `matching to a grey palette would drain the texture's colour. Pass ` +
              `--no-color-match to silence this, or nothing: the texture is unchanged.`,
          };
        } else {
          staged = matched;
          colorMatched = true;
          imageSha = await sha256Hex(new Uint8Array(await fs.readFile(fidelityImage)));
          const clamp = stats.clamped.length > 0 ? ` clamped:${stats.clamped.join('')}` : '';
          yield {
            t: 'progress',
            jobId,
            at: at(),
            step: `color-match:hue-${stats.hueDistBefore}->${stats.hueDistAfter}` +
              `:L-${stats.lBefore}->${stats.lAfter}${clamp}`,
            done: ++done,
            total,
          };
        }
      }
    }

    let reprojected = false;
    reproject:
    if (wantReproject) {
      const image = fidelityImage;
      let readable = true;
      try {
        await fs.stat(image);
      } catch {
        readable = false;
      }
      if (!readable) {
        // an EXPLICIT ask (--reproject, or an --image that does not exist) is
        // an error; the silent DEFAULT missing its stored source soft-skips
        // with a warn, exactly like colour-match above
        if (opts.reproject === true || opts.imagePath !== undefined) {
          throw Object.assign(
            new Error(
              `Cannot reproject: the source image is missing at ${image} - pass --image explicitly`,
            ),
            { code: 'no-source' },
          );
        }
        yield {
          t: 'warn',
          jobId,
          at: at(),
          code: 'reproject-skipped',
          message: `the stored source image is missing at ${image}, so the default ` +
            `reprojection did not run. The texture keeps its generated detail.`,
        };
        break reproject;
      }
      const painted =
        `${paths.canonicalDir}/pick-${crypto.randomUUID()}-${opts.resultId}-reprojected.tmp.glb`;
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
          done: ++done,
          total,
        };
        imageSha = imageSha ?? await sha256Hex(new Uint8Array(await fs.readFile(image)));
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

    // Core retains both revisions and publishes these staged bytes with the manifest patch.
    const finalBytes = new Uint8Array(await fs.readFile(staged));
    const repainted = reprojected || colorMatched;
    const suffix = reprojected && colorMatched
      ? ' (color-matched, reprojected)'
      : reprojected
      ? ' (reprojected)'
      : colorMatched
      ? ' (color-matched)'
      : '';
    await pickResult(opts.workspace, opts.resultId, {
      label: `Pick ${opts.resultId}${suffix}`,
      canonicalSource: staged,
      // the height is measured from the mesh: the receipt does not carry one,
      // and core refuses to invent it
      heightM: await heightOf(finalBytes),
      texturedBy,
      reprojected,
      // either fidelity pass repaints the texture, so the receipt's hash
      // describes bytes that are no longer the canonical ones; the image both
      // passes conditioned on rides in the SAME patch
      ...(repainted
        ? {
          canonicalMesh: {
            gltfSha256: await sha256Hex(finalBytes),
            ...(colorMatched ? { colorMatched: true } : {}),
            ...(imageSha !== undefined ? { imageSha256: imageSha } : {}),
          },
        }
        : {}),
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
        await fs.rm(path);
      } catch {
        // renamed into place, or never written — either way there is nothing
        // left to clean
      }
    }
  }
}

export function runPickJob(opts: PickJobOptions): AsyncIterable<JobEvent> {
  return workspaceJob(opts.workspace, () => executePickJob(opts));
}
