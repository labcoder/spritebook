/**
 * Concurrency-limited job queue with cancel and retry-on-`retryable`.
 *
 * Executors are async generators of JobEvents (the render seam shape). The
 * queue owns: the 'queued' event, the concurrency gate, bounded retries when
 * an executor's LAST event is an error with `retryable: true`, cancellation
 * via AbortSignal, and forwarding every event through the EventBus.
 */
import type { JobEvent, JobSpec } from '@spritebook/schema';
import { JobSpecSchema, parseWith } from '@spritebook/schema';
import type { EventBus } from './events.ts';

export type JobExecutor = (spec: JobSpec, signal: AbortSignal) => AsyncIterable<JobEvent>;

export type JobOutcomeKind = 'done' | 'error' | 'cancelled';

export interface JobOutcome {
  kind: JobOutcomeKind;
  attempts: number;
  /** last error event when kind is 'error' */
  error?: Extract<JobEvent, { t: 'error' }>;
}

export interface JobHandle {
  jobId: JobSpec['jobId'];
  done: Promise<JobOutcome>;
  cancel(): void;
}

interface QueueItem {
  spec: JobSpec;
  executor: JobExecutor;
  controller: AbortController;
  resolve: (o: JobOutcome) => void;
  started: boolean;
}

export interface JobQueueOptions {
  bus: EventBus;
  concurrency?: number;
  /** additional attempts after the first, for retryable errors */
  maxRetries?: number;
  /** injectable clock for deterministic tests */
  now?: () => string;
}

export class JobQueue {
  #bus: EventBus;
  #concurrency: number;
  #maxRetries: number;
  #now: () => string;
  #pending: QueueItem[] = [];
  #running = new Map<string, QueueItem>();

  constructor(opts: JobQueueOptions) {
    this.#bus = opts.bus;
    this.#concurrency = Math.max(1, opts.concurrency ?? 2);
    this.#maxRetries = Math.max(0, opts.maxRetries ?? 1);
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  get runningCount(): number {
    return this.#running.size;
  }

  submit(spec: JobSpec, executor: JobExecutor): JobHandle {
    const valid = parseWith(JobSpecSchema, spec, 'JobSpec');
    const controller = new AbortController();
    let resolve!: (o: JobOutcome) => void;
    const done = new Promise<JobOutcome>((r) => (resolve = r));
    const item: QueueItem = { spec: valid, executor, controller, resolve, started: false };
    this.#pending.push(item);
    this.#bus.emit({ t: 'queued', jobId: valid.jobId, at: this.#now() });
    queueMicrotask(() => this.#pump());
    return {
      jobId: valid.jobId,
      done,
      cancel: () => this.#cancel(item),
    };
  }

  #cancel(item: QueueItem): void {
    const idx = this.#pending.indexOf(item);
    if (idx >= 0) {
      // never started: emit the terminal error ourselves
      this.#pending.splice(idx, 1);
      const event: JobEvent = {
        t: 'error',
        jobId: item.spec.jobId,
        at: this.#now(),
        code: 'cancelled',
        message: 'Job cancelled before it started',
        retryable: false,
      };
      this.#bus.emit(event);
      item.resolve({ kind: 'cancelled', attempts: 0, error: event as JobOutcome['error'] });
      return;
    }
    item.controller.abort();
  }

  #pump(): void {
    while (this.#running.size < this.#concurrency && this.#pending.length > 0) {
      const item = this.#pending.shift()!;
      item.started = true;
      this.#running.set(item.spec.jobId, item);
      this.#run(item).finally(() => {
        this.#running.delete(item.spec.jobId);
        this.#pump();
      });
    }
  }

  async #run(item: QueueItem): Promise<void> {
    const { spec, executor, controller } = item;
    let attempts = 0;
    for (;;) {
      attempts++;
      let lastError: Extract<JobEvent, { t: 'error' }> | undefined;
      let sawDone = false;
      try {
        for await (const event of executor(spec, controller.signal)) {
          this.#bus.emit(event); // bus validates against the schema
          if (event.t === 'error') lastError = event;
          if (event.t === 'done') sawDone = true;
        }
      } catch (err) {
        // executors should emit error events; a throw is converted to one
        lastError = {
          t: 'error',
          jobId: spec.jobId,
          at: this.#now(),
          code: 'executor-throw',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        };
        this.#bus.emit(lastError);
      }

      if (controller.signal.aborted) {
        if (!lastError || lastError.code !== 'cancelled') {
          lastError = {
            t: 'error',
            jobId: spec.jobId,
            at: this.#now(),
            code: 'cancelled',
            message: 'Job cancelled',
            retryable: false,
          };
          this.#bus.emit(lastError);
        }
        item.resolve({ kind: 'cancelled', attempts, error: lastError });
        return;
      }
      if (sawDone) {
        item.resolve({ kind: 'done', attempts });
        return;
      }
      if (lastError?.retryable && attempts <= this.#maxRetries) {
        continue; // executor re-runs; it emits its own started/... events
      }
      item.resolve({
        kind: 'error',
        attempts,
        error: lastError ?? {
          t: 'error',
          jobId: spec.jobId,
          at: this.#now(),
          code: 'no-terminal-event',
          message: 'Executor finished without done or error',
          retryable: false,
        },
      });
      return;
    }
  }
}
