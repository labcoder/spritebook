import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  type JobEvent,
  type MotionReview,
  parseWith,
  ResultIdSchema,
} from '@spritebook/schema';
import {
  readWorkspace,
  resourcePath,
  resultPaths,
  sha256Bytes,
  writeAtomic,
} from '@spritebook/core';
import { runImportJob } from '@spritebook/gen';
import { runRigJob } from '@spritebook/rig';
import {
  defaultModelsRoot,
  projectPins,
  resolvePinnedInstalled,
  versionDir,
} from '@spritebook/registry';
import { readMotionReview, runMotionAudition } from './audition.ts';

const RECIPE = 'candidate-motion@1';
const digest = async (bytes: string | Uint8Array) =>
  sha256Bytes(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);

async function source(workspace: string, id: string, pinsPath?: string) {
  parseWith(ResultIdSchema, id, 'Candidate');
  const manifest = await readWorkspace(workspace);
  const result = manifest.generation.results.find((result) =>
    result.id === id && !result.discarded
  );
  if (!result) throw new Error(`Candidate ${id} is missing or discarded.`);
  const path = resultPaths(workspace, id).model;
  if (await digest(await fs.readFile(path)) !== result.output.gltfSha256) {
    throw new Error(
      'Candidate bytes differ from the generation receipt. Restore the source before testing.',
    );
  }
  return { result, path, pins: await projectPins({ workspace, pinsPath }) };
}

async function location(
  workspace: string,
  id: string,
  sourceSha256: string,
  pins: unknown,
  backendVersion: string,
) {
  const recipe = { method: RECIPE, sourceSha256, pins: pins ?? null, backendVersion };
  const root = join(workspace, 'anim/candidates', id, await digest(canonicalJson(recipe)));
  return { recipe, root, child: join(root, 'character') };
}

/** Candidate experiments own derived workspaces; the selected character is never replaced. */
export async function* runCandidateAudition(
  workspace: string,
  id: string,
  pinsPath?: string,
): AsyncIterable<JobEvent> {
  const jobId = 'candidate-motion' as JobEvent['jobId'];
  const at = () => new Date().toISOString();
  const start = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };
  try {
    const { result, path, pins } = await source(workspace, id, pinsPath);
    const modelsRoot = defaultModelsRoot();
    const installed = await resolvePinnedInstalled(modelsRoot, 'unirig', undefined, {
      workspace,
      pinsPath,
    });
    if (!installed) {
      throw Object.assign(
        new Error('Install UniRig in Manage extensions before testing a generated candidate.'),
        { code: 'model-missing' },
      );
    }
    const { recipe, root, child } = await location(
      workspace,
      id,
      result.output.gltfSha256,
      pins,
      installed.version,
    );
    await fs.mkdir(root, { recursive: true });
    if (pins) await writeAtomic(join(root, 'pins.json'), canonicalJson(pins));
    let character;
    try {
      await fs.stat(join(child, 'character.json'));
      character = await readWorkspace(child);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!character?.canonicalMesh) {
      for await (
        const event of runImportJob({
          jobId: 'candidate-import',
          workspace: child,
          input: path,
          characterId: 'candidate',
          displayName: id,
        })
      ) {
        yield event;
        if (event.t === 'error') return;
      }
      character = await readWorkspace(child);
    }
    if (!character.rig) {
      for await (
        const event of runRigJob({
          jobId: 'candidate-rig',
          workspace: child,
          modelPath: join(child, 'canonical/model.glb'),
          outDir: join(child, 'rig'),
          sidecarDir: process.env['SPRITEBOOK_SIDECAR_DIR'] ?? resourcePath('sidecar'),
          modelDir: versionDir(modelsRoot, 'unirig', installed.version),
          seed: 0,
          orientationFixes: ['upright', 'face-front', 'feet-ground', 'center'],
        })
      ) {
        yield event;
        if (event.t === 'error') return;
      }
    }
    if (!await readMotionReview(child)) {
      for await (const event of runMotionAudition(child)) {
        yield event;
        if (event.t === 'error') return;
      }
    }
    const pointer = join(workspace, 'anim/candidates', id, 'review.json');
    await writeAtomic(pointer, canonicalJson(recipe));
    yield { t: 'artifact', jobId, at: at(), kind: 'candidate-workspace', path: child };
    yield { t: 'artifact', jobId, at: at(), kind: 'candidate-motion-review', path: pointer };
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - start) / 1000 };
  } catch (error) {
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: (error as { code?: string }).code ?? 'candidate-review-failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}

export async function readCandidateReview(
  workspace: string,
  id: string,
  pinsPath?: string,
): Promise<MotionReview | null> {
  const { result, pins } = await source(workspace, id, pinsPath);
  let pointer;
  try {
    pointer = JSON.parse(
      await fs.readFile(join(workspace, 'anim/candidates', id, 'review.json'), 'utf8'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (typeof pointer?.backendVersion !== 'string' || !pointer.backendVersion.length) {
    throw new Error('Invalid candidate review receipt.');
  }
  const { recipe, child } = await location(
    workspace,
    id,
    result.output.gltfSha256,
    pins,
    pointer.backendVersion,
  );
  if (canonicalJson(recipe) !== canonicalJson(pointer)) return null;
  return await readMotionReview(child);
}
