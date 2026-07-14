/**
 * @spritebook/render - headless WebGPU: MRT AOVs, skinning, readback.
 *
 * THE SEAM (D-004 rider - do not weaken): this module's public surface is
 * exactly the boundary a Rust+wgpu `renderd` subprocess could replace.
 * Everything crosses as FILES and NDJSON EVENTS:
 *   - inputs: paths to canonical glTF + presets/params (plain data)
 *   - outputs: files written under `outDir` + a JobEvent stream
 * No pixel buffers, mesh handles, or GPU objects may ever appear in this API.
 * Callers (core queue, cli) program against this interface only, so a backend
 * swap is an organ transplant, not surgery on every caller.
 *
 * P1-T1 stub: emits the event contract without touching a GPU. The real
 * implementation lands in P2 per docs/internal/roadmap/p2.md and the
 * webgpu-headless-rendering skill.
 */
import type { JobEvent } from '@spritebook/schema';

export interface RenderJobSpec {
  jobId: string;
  /** canonical glTF produced by the importer border (a file path, always) */
  modelPath: string;
  /** camera preset id (resolved by core against the project manifest) */
  cameraPreset: string;
  /** style preset id - the NPR stack params */
  stylePreset: string;
  /** all render products (AOV pages, frames) are written under here */
  outDir: string;
}

/** Stub render job: yields the event contract (data-models v0.2 shape) in order. */
export async function* runRenderJob(spec: RenderJobSpec): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = spec.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };
  yield { t: 'progress', jobId, at: at(), step: 'stub', done: 1, total: 1 };
  yield { t: 'artifact', jobId, at: at(), kind: 'stub', path: `${spec.outDir}/stub.txt` };
  yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - t0) / 1000 };
}
