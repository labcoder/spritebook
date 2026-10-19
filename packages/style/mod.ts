import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * @spritebook/style - the NPR style stack behind the D-004 seam: StyleJobSpec
 * (plain data) in, styled sprite files + a StyleResult JSON out; no pixels or GPU
 * objects cross this API. runStyleJob renders the supersampled AOVs via the
 * render seam, then styles them on the CPU. The pure `styleFromAovs` is
 * re-exported so tests drive committed AOV fixtures with no GPU.
 */
import type { CameraPreset, JobEvent } from '@spritebook/schema';
import { runRenderJob } from '@spritebook/render';
import type { StyleJobSpec } from './contracts.ts';
import { styleFromAovs } from './pipeline.ts';

export { styleClipsFromAovs, styleFromAovs } from './pipeline.ts';
export type { ClipAovSource } from './pipeline.ts';
export {
  canonicalStyleId,
  CEL_2,
  DEFAULT_STYLE_PRESET_ID,
  PAINTERLY,
  PIXEL,
  PRESETS,
  resolveStyle,
  STYLE_ALIASES,
  styleAliasNote,
} from './presets.ts';
// pure AOV utilities, re-exported for the pack stage (bake composes render ->
// style -> pack via files; pack reads the same Sx AOVs to build 1x AOV pages)
export { readAov } from './aovio.ts';
export type { AovImage, AovSource, StyleJobSpec, StyleResult } from './contracts.ts';

/** Scale a 1x output CameraPreset up to the supersample render resolution. */
function supersampleCamera(camera: CameraPreset, s: number): CameraPreset {
  return {
    ...camera,
    pixelsPerMeter: camera.pixelsPerMeter * s,
    cellPx: { w: camera.cellPx.w * s, h: camera.cellPx.h * s },
    paddingPx: camera.paddingPx * s,
  };
}

export async function* runStyleJob(spec: StyleJobSpec): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = spec.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  const s = spec.style.temporal.superSample;
  const aovDir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    // 1. render the supersampled AOVs (idle loop) via the render seam
    yield { t: 'progress', jobId, at: at(), step: 'render', done: 1, total: 3 };
    for await (
      const e of runRenderJob({
        jobId: `${spec.jobId}-render`,
        modelPath: spec.modelPath,
        camera: supersampleCamera(spec.camera, s),
        frames: spec.frames,
        pose: 'idle',
        stylePreset: spec.style.id,
        outDir: aovDir,
      })
    ) {
      if (e.t === 'error') {
        yield {
          t: 'error',
          jobId,
          at: at(),
          code: 'render-failed',
          message: e.message,
          retryable: e.retryable,
        };
        return;
      }
    }

    // 2. style the AOVs on the CPU (files in, files out)
    yield { t: 'progress', jobId, at: at(), step: 'style', done: 2, total: 3 };
    const result = await styleFromAovs(
      {
        framesDir: `${aovDir}/frames`,
        directions: spec.camera.directions,
        frames: spec.frames,
        width: spec.camera.cellPx.w * s,
        height: spec.camera.cellPx.h * s,
      },
      spec.camera,
      spec.style,
      spec.outDir,
    );

    // 3. write the StyleResult (palette + flicker + flags -> the packer folds it
    // into the BakeManifest at P2-T3) and announce artifacts
    const resultPath = `${spec.outDir}/style-result.json`;
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
    yield { t: 'progress', jobId, at: at(), step: 'write', done: 3, total: 3 };
    yield { t: 'artifact', jobId, at: at(), kind: 'styled-frames', path: result.styledDir };
    yield { t: 'artifact', jobId, at: at(), kind: 'style-result', path: resultPath };
    for (const flag of result.flags) {
      yield { t: 'warn', jobId, at: at(), code: flag.code, message: flag.message };
    }
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - t0) / 1000 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { t: 'error', jobId, at: at(), code: 'style-failed', message, retryable: false };
  } finally {
    await fs.rm(aovDir, { recursive: true }).catch(() => {});
  }
}
