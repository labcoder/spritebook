/**
 * Scripted stub bake — the T3 acceptance executor. Emits the FULL event
 * vocabulary with first occurrences in contract order (queued comes from the
 * queue): started, progress, artifact, warn, then a retryable error on the
 * first attempt; the retry attempt completes with done. Deterministic when
 * given a fixed clock.
 */
import type { JobEvent, JobSpec } from '@spritebook/schema';

export interface StubBakeOptions {
  /** injectable clock for deterministic tests */
  now?: () => string;
  /** how many frames to report progress over */
  frames?: number;
  /** fail (retryably) on attempt 1 to exercise the retry path */
  failFirstAttempt?: boolean;
}

export function makeStubBake(opts: StubBakeOptions = {}): {
  executor: (spec: JobSpec, signal: AbortSignal) => AsyncIterable<JobEvent>;
} {
  const now = opts.now ?? (() => new Date().toISOString());
  const frames = opts.frames ?? 3;
  let attempt = 0;

  async function* executor(spec: JobSpec, signal: AbortSignal): AsyncIterable<JobEvent> {
    attempt++;
    const { jobId } = spec;
    const t0 = Date.now();
    yield { t: 'started', jobId, at: now() };
    for (let f = 1; f <= frames; f++) {
      if (signal.aborted) {
        yield {
          t: 'error',
          jobId,
          at: now(),
          code: 'cancelled',
          message: 'Job cancelled',
          retryable: false,
        };
        return;
      }
      yield { t: 'progress', jobId, at: now(), step: 'render', done: f, total: frames };
      await Promise.resolve(); // yield to the scheduler like a real executor
    }
    yield { t: 'artifact', jobId, at: now(), kind: 'atlas', path: 'atlas-0-lit.png' };
    yield {
      t: 'warn',
      jobId,
      at: now(),
      code: 'palette-overflow',
      message: 'Palette clamped to preset maximum',
    };
    if (opts.failFirstAttempt !== false && attempt === 1) {
      yield {
        t: 'error',
        jobId,
        at: now(),
        code: 'device-lost',
        message: 'Simulated transient GPU loss',
        retryable: true,
      };
      return;
    }
    yield { t: 'done', jobId, at: now(), wallTimeS: (Date.now() - t0) / 1000 };
  }

  return { executor };
}
