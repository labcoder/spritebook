/**
 * Concurrency-limited job queue with cancel and retry-on-`retryable`.
 *
 * Executors are async generators of JobEvents (the render seam shape). The
 * queue owns: the 'queued' event, the concurrency gate, bounded retries when
 * an executor's LAST event is an error with `retryable: true`, cancellation
 * via AbortSignal, and forwarding every event through the EventBus.
 *
 * ## The VRAM budget (P4-T3)
 *
 * A job count is the wrong unit for sidecar work. Two TRELLIS jobs at 16 GiB
 * each fit "concurrency 2" perfectly and OOM a 24 GiB card; two rembg jobs at
 * 0.5 GiB leave twenty gigabytes idle under the same setting. So the queue
 * takes a second, orthogonal gate: each job may declare the VRAM it holds for
 * its run, and the queue starts it only when the budget can carry it.
 *
 * Admission is STRICTLY FIFO. If the job at the head does not fit, nothing
 * behind it starts either, even when something behind it would. That costs
 * throughput and buys two things worth more: it cannot starve a large job
 * behind a stream of small ones, and "why is nothing running" always has the
 * same one-sentence answer — the head needs N and M is free. A backfill policy
 * would need job durations to be safe, and nothing here knows them.
 *
 * Two rules keep it from lying:
 *  - a job asking for more than the whole budget is REFUSED at submit, with
 *    the numbers, rather than queued forever behind a gate it can never pass;
 *  - a job that waits on VRAM says so once, on the bus, because a queue that
 *    is deliberately holding work is indistinguishable from a hung one.
 *
 * The budget is passed in, never detected here: detection is nvidia-smi in
 * @spritebook/registry, and core does not depend on the registry.
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
  /** GiB this job holds while it runs; 0 makes no claim on the budget */
  vramGb: number;
  /** the bus has already been told this one is waiting on VRAM */
  toldBlocked: boolean;
}

export interface JobQueueOptions {
  bus: EventBus;
  concurrency?: number;
  /** additional attempts after the first, for retryable errors */
  maxRetries?: number;
  /** injectable clock for deterministic tests */
  now?: () => string;
  /**
   * Total VRAM the queue may commit at once, GiB. Omitted means no budgeting
   * at all — every job's claim is ignored and only `concurrency` gates. That
   * is the honest default on a machine where detection returned null: an
   * invented budget would refuse work the card can actually do.
   */
  vramBudgetGb?: number;
}

export interface SubmitOptions {
  /**
   * GiB this job holds for its whole run — a model's `minVramGb`, typically.
   * Omitted or 0 means the job makes no claim (CPU sidecars like rembg), and
   * it is then gated by `concurrency` alone.
   */
  vramGb?: number;
}

export class JobQueue {
  #bus: EventBus;
  #concurrency: number;
  #maxRetries: number;
  #now: () => string;
  #pending: QueueItem[] = [];
  #running = new Map<string, QueueItem>();
  #vramBudgetGb: number | undefined;
  #vramCommittedGb = 0;

  constructor(opts: JobQueueOptions) {
    this.#bus = opts.bus;
    this.#concurrency = Math.max(1, opts.concurrency ?? 2);
    this.#maxRetries = Math.max(0, opts.maxRetries ?? 1);
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#vramBudgetGb = opts.vramBudgetGb !== undefined && opts.vramBudgetGb > 0
      ? opts.vramBudgetGb
      : undefined;
  }

  get runningCount(): number {
    return this.#running.size;
  }

  /** GiB currently committed to running jobs — 0 when nothing declared any. */
  get vramCommittedGb(): number {
    return this.#vramCommittedGb;
  }

  /**
   * Why the queue is holding work, or null when it is not. The answer names
   * the job at the head and the two numbers, because "the queue looks stuck"
   * is otherwise indistinguishable from "the queue is doing its job".
   */
  blockedReason(): string | null {
    const head = this.#pending[0];
    if (head === undefined || this.#running.size >= this.#concurrency) return null;
    if (this.#fits(head)) return null;
    return `${head.spec.jobId} needs ${head.vramGb} GiB and ${this.#freeGb()} GiB of the ` +
      `${this.#vramBudgetGb} GiB budget is free (${this.#running.size} job(s) running)`;
  }

  submit(spec: JobSpec, executor: JobExecutor, opts: SubmitOptions = {}): JobHandle {
    const valid = parseWith(JobSpecSchema, spec, 'JobSpec');
    const controller = new AbortController();
    let resolve!: (o: JobOutcome) => void;
    const done = new Promise<JobOutcome>((r) => (resolve = r));
    const vramGb = Math.max(0, opts.vramGb ?? 0);
    const item: QueueItem = {
      spec: valid,
      executor,
      controller,
      resolve,
      started: false,
      vramGb,
      toldBlocked: false,
    };
    // A claim larger than the whole budget can never be admitted, so queuing
    // it would be a silent hang — and it would block every job behind it
    // under FIFO admission. Refused here, with both numbers.
    if (this.#vramBudgetGb !== undefined && vramGb > this.#vramBudgetGb) {
      const event: JobEvent = {
        t: 'error',
        jobId: valid.jobId,
        at: this.#now(),
        code: 'vram-budget-exceeded',
        message: `This job needs ${vramGb} GiB of VRAM, and the whole queue budget is ` +
          `${this.#vramBudgetGb} GiB. It could never start. Raise the budget, or run this ` +
          `job on a machine with more VRAM.`,
        retryable: false,
      };
      this.#bus.emit(event);
      resolve({ kind: 'error', attempts: 0, error: event as JobOutcome['error'] });
      return { jobId: valid.jobId, done, cancel: () => {} };
    }
    this.#pending.push(item);
    this.#bus.emit({ t: 'queued', jobId: valid.jobId, at: this.#now() });
    queueMicrotask(() => this.#pump());
    return {
      jobId: valid.jobId,
      done,
      cancel: () => this.#cancel(item),
    };
  }

  #freeGb(): number {
    if (this.#vramBudgetGb === undefined) return Infinity;
    // floating-point GiB (nvidia-smi reports one decimal), so round the
    // subtraction rather than letting 24 - 7.9 - 16.1 come out negative
    return Math.round((this.#vramBudgetGb - this.#vramCommittedGb) * 10) / 10;
  }

  #fits(item: QueueItem): boolean {
    return this.#vramBudgetGb === undefined || item.vramGb <= this.#freeGb();
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
      const head = this.#pending[0]!;
      if (!this.#fits(head)) {
        // FIFO: the head keeps its place. Nothing behind it is promoted, so a
        // 16 GiB job cannot be starved by a stream of 1 GiB ones.
        if (!head.toldBlocked) {
          head.toldBlocked = true;
          this.#bus.emit({
            t: 'warn',
            jobId: head.spec.jobId,
            at: this.#now(),
            code: 'vram-wait',
            message: `Waiting on VRAM: ${this.blockedReason()}. Jobs behind it wait too — ` +
              `admission is in order, so nothing here can be starved.`,
          });
        }
        return;
      }
      const item = this.#pending.shift()!;
      item.started = true;
      this.#vramCommittedGb = Math.round((this.#vramCommittedGb + item.vramGb) * 10) / 10;
      this.#running.set(item.spec.jobId, item);
      void this.#settle(item);
    }
  }

  /**
   * Run one job, then release what it held BEFORE resolving its handle.
   *
   * The order matters and is easy to get backwards: `#run` used to resolve the
   * handle itself and the release rode a `.finally()`, so anyone who awaited
   * `handle.done` and then read the budget saw the job's GiB still committed.
   * Nothing over-admitted — `#pump` only ever ran after the release — but the
   * queue reported a state it was not in, which is the kind of accounting that
   * looks fine until someone builds a scheduler on top of it.
   */
  async #settle(item: QueueItem): Promise<void> {
    let outcome: JobOutcome;
    try {
      outcome = await this.#run(item);
    } catch (err) {
      // #run catches its executor; reaching here is a bug in the queue itself,
      // and swallowing it would strand the caller's promise forever
      outcome = {
        kind: 'error',
        attempts: 0,
        error: {
          t: 'error',
          jobId: item.spec.jobId,
          at: this.#now(),
          code: 'queue-internal',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      };
    } finally {
      this.#running.delete(item.spec.jobId);
      // released on EVERY exit — done, error, cancel, or a throw. A leak here
      // is permanent: the budget shrinks by one job's claim and the queue
      // quietly runs less work every cycle until it deadlocks.
      this.#vramCommittedGb = Math.round((this.#vramCommittedGb - item.vramGb) * 10) / 10;
    }
    item.resolve(outcome);
    this.#pump();
  }

  async #run(item: QueueItem): Promise<JobOutcome> {
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
        return { kind: 'cancelled', attempts, error: lastError };
      }
      if (sawDone) return { kind: 'done', attempts };
      if (lastError?.retryable && attempts <= this.#maxRetries) {
        continue; // executor re-runs; it emits its own started/... events
      }
      return {
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
      };
    }
  }
}
