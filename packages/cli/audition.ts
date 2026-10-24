import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { loadClip, loadPack, loadSkeletonRest, sampleClip } from '@spritebook/anim';
import {
  canonicalJson,
  type JobEvent,
  MOTION_REVIEW_CLIPS,
  type MotionReview,
  MotionReviewSchema,
  parseWith,
} from '@spritebook/schema';
import { readWorkspace, resolveCamera, sha256Bytes, writeAtomic } from '@spritebook/core';
import { BUNDLED_PACK, runBakeJob } from '@spritebook/pack';
import { loadRiggedAsset, motionSurfaceStats } from '@spritebook/rig';
import { RENDERER_VERSION } from '@spritebook/render';
import { resolveStyle } from '@spritebook/style';

const digest = async (path: string) => sha256Bytes(new Uint8Array(await fs.readFile(path)));

/** Derived review; never enables clips, accepts a rig or changes the saved look/bake. */
export async function* runMotionAudition(
  workspace: string,
  pinsPath?: string,
): AsyncIterable<JobEvent> {
  const jobId = 'motion-review' as JobEvent['jobId'], at = () => new Date().toISOString();
  const start = performance.now();
  yield { t: 'started', jobId, at: at() };
  try {
    const character = await readWorkspace(workspace);
    if (!character.rig || !character.canonicalMesh) {
      throw new Error('Build or import a rig before reviewing motion.');
    }
    const modelPath = join(workspace, 'canonical/model.glb');
    const sourceSha256 = await digest(modelPath);
    if (sourceSha256 !== character.canonicalMesh.gltfSha256) {
      throw new Error(
        'The canonical mesh differs from its recorded hash. Restore it before reviewing motion.',
      );
    }
    let bakeDir = '';
    for await (
      const event of runBakeJob({
        jobId: 'motion-review-bake',
        workspace,
        pinsPath,
        characterId: character.id,
        modelPath,
        camera: resolveCamera('standard-30', {
          cellPx: { w: 96, h: 128 },
          pixelsPerMeter: 32,
          paddingPx: 24,
          directions: 4,
        }),
        style: resolveStyle('clean', {
          temporal: {
            superSample: 1,
            clusterVote: false,
            texelSnap: true,
            paletteHysteresisEps: 0,
          },
        }),
        frames: 8,
        clips: MOTION_REVIEW_CLIPS.map((clipId) => ({
          clipId,
          frames: 8,
          speed: 1,
          holdLast: clipId === 'jump-start' || clipId === 'jump-land',
        })),
        outRoot: join(workspace, 'anim/reviews'),
      })
    ) {
      yield event;
      if (event.t === 'error') return;
      if (event.t === 'artifact' && event.kind === 'bake-dir') bakeDir = event.path;
    }
    if (!bakeDir) throw new Error('Motion review did not produce a bake.');
    const io = new NodeIO();
    const asset = await loadRiggedAsset(modelPath);
    const clips: MotionReview['clips'] = [];
    for (const [index, clipId] of MOTION_REVIEW_CLIPS.entries()) {
      yield { t: 'progress', jobId, at: at(), step: 'motion-surface-check', done: index, total: 4 };
      const preview = join(bakeDir, `preview-${clipId}.glb`);
      const doc = await io.read(preview);
      const clip = loadClip(doc, clipId, clipId);
      clips.push({
        clipId,
        preview,
        contact: join(bakeDir, `contact-${clipId}.gif`),
        sourceSha256: await digest(join(BUNDLED_PACK, `clips/${clipId}.glb`)),
        stats: motionSurfaceStats(
          asset,
          sampleClip(clip, loadSkeletonRest(doc), { frames: 17, speed: 1, holdLast: true }),
        ),
      });
    }
    const bake = JSON.parse(await fs.readFile(join(bakeDir, 'manifest.json'), 'utf8'));
    const report = parseWith(MotionReviewSchema, {
      version: 1,
      method: 'motion-surface@1',
      sourceSha256,
      renderer: RENDERER_VERSION,
      bakeDir,
      flags: bake.flags.map((flag: { code: string }) => flag.code),
      clips,
    }, 'Motion review');
    const path = join(workspace, 'anim/motion-review.json');
    if (sourceSha256 !== await digest(modelPath)) {
      throw new Error('The mesh changed during review. Retry with the current rig.');
    }
    await writeAtomic(path, canonicalJson(report));
    yield { t: 'artifact', jobId, at: at(), kind: 'motion-review', path };
    yield {
      t: 'warn',
      jobId,
      at: at(),
      code: 'motion-visual-review',
      message:
        'Review every motion and direction. Surface checks do not certify anatomical binding, clothing coverage or collision-free motion.',
    };
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - start) / 1000 };
  } catch (error) {
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: 'motion-review-failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}

/** A stale or interrupted review cannot be mistaken for evidence about the current rig. */
export async function readMotionReview(
  workspace: string,
  pinsPath?: string,
): Promise<MotionReview | null> {
  let report: MotionReview;
  try {
    report = parseWith(
      MotionReviewSchema,
      JSON.parse(await fs.readFile(join(workspace, 'anim/motion-review.json'), 'utf8')),
      'Motion review',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (
    report.sourceSha256 !== await digest(join(workspace, 'canonical/model.glb')) ||
    report.renderer !== RENDERER_VERSION
  ) return null;
  await loadPack(BUNDLED_PACK, { workspace, pinsPath });
  const local = relative(resolve(workspace, 'anim/reviews'), resolve(report.bakeDir));
  if (
    local === '..' || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(local)
  ) throw new Error('Motion review artifacts must stay in this workspace.');
  for (const clip of report.clips) {
    if (
      resolve(clip.preview) !== resolve(report.bakeDir, `preview-${clip.clipId}.glb`) ||
      resolve(clip.contact) !== resolve(report.bakeDir, `contact-${clip.clipId}.gif`)
    ) throw new Error('Motion review has an invalid artifact path.');
    if (clip.sourceSha256 !== await digest(join(BUNDLED_PACK, `clips/${clip.clipId}.glb`))) {
      return null;
    }
  }
  return report;
}
