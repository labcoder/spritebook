/**
 * @spritebook/render - headless WebGPU: MRT AOVs, skinning, readback.
 *
 * THE SEAM (D-004 rider - do not weaken): this module's public surface is
 * exactly the boundary a Rust+wgpu `renderd` subprocess could replace.
 * Everything crosses as FILES and NDJSON EVENTS:
 *   - inputs: a path to canonical glTF + a resolved CameraPreset (plain data)
 *   - outputs: files written under `outDir` + a JobEvent stream
 * No pixel buffers, mesh handles, or GPU objects may ever appear in this API.
 * Callers (core queue, cli) program against this interface only, so a backend
 * swap is an organ transplant, not surgery on every caller.
 *
 * P2-T1: the real implementation. Loads the canonical glb, solves the
 * orthographic per-direction framing (world-locked, texel-snapped), renders the
 * 5-AOV MRT pass for every direction x frame with double-buffered readback, and
 * writes one PNG per AOV plus a throughput report. `device.lost` becomes a
 * RETRYABLE error (webgpu-headless-rendering skill).
 */
import type { JobEvent } from '@spritebook/schema';
import { CameraPresetSchema, parseWith } from '@spritebook/schema';
import type { RenderJobSpec } from './contracts.ts';
import { getGpu } from './gpu.ts';
import { makeRenderer } from './renderer.ts';

export type { RenderJobSpec } from './contracts.ts';

/** Render one canonical model to per-direction AOV pages + a throughput report. */
export async function* runRenderJob(spec: RenderJobSpec): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = spec.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  // keep `gpu` in scope so the catch can classify device.lost.
  let gpu: Awaited<ReturnType<typeof getGpu>> | undefined;
  try {
    parseWith(CameraPresetSchema, spec.camera, 'CameraPreset'); // defensive: plain data in
    yield { t: 'progress', jobId, at: at(), step: 'device', done: 1, total: 4 };
    gpu = await getGpu();

    const shaderSrc = await Deno.readTextFile(new URL('./shaders.wgsl', import.meta.url));
    const renderer = await makeRenderer(gpu, spec, shaderSrc);
    yield { t: 'progress', jobId, at: at(), step: 'setup', done: 2, total: 4 };

    const { summary, throughputPath } = await renderer.renderAll(spec.outDir, spec.frames);
    // renderAll has fully drained the readback pool, so no queued work references
    // the renderer's textures/buffers — safe to release them (M3: no per-job leak).
    renderer.dispose();
    yield { t: 'progress', jobId, at: at(), step: 'render', done: 3, total: 4 };

    if (gpu.lost) {
      yield {
        t: 'error',
        jobId,
        at: at(),
        code: 'device-lost',
        message: `device lost mid-render: ${gpu.lost.reason} - ${gpu.lost.message}`,
        retryable: true,
      };
      return;
    }

    const summaryPath = `${spec.outDir}/render-summary.json`;
    await Deno.writeTextFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');
    yield { t: 'progress', jobId, at: at(), step: 'write', done: 4, total: 4 };

    yield { t: 'artifact', jobId, at: at(), kind: 'render-summary', path: summaryPath };
    yield { t: 'artifact', jobId, at: at(), kind: 'aov-frames', path: summary.framesDir };
    yield { t: 'artifact', jobId, at: at(), kind: 'throughput', path: throughputPath };
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - t0) / 1000 };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // classify device loss from either the captured lost-info OR the thrown error
    // itself — device.lost resolves asynchronously, so a synchronous submit-time
    // loss can throw before `gpu.lost` is populated (m7).
    const lost = gpu?.lost != null || /device (?:was )?lost|lost the device/i.test(raw);
    const message = gpu?.lost ? `device lost: ${gpu.lost.reason} - ${gpu.lost.message}` : raw;
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: lost ? 'device-lost' : 'render-failed',
      message,
      retryable: lost,
    };
  }
}
