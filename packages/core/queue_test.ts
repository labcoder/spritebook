import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { JobEvent, JobSpec } from '@spritebook/schema';
import { EventBus } from './events.ts';
import { JobQueue } from './queue.ts';

const at = '2026-07-12T00:00:00Z';
const spec = (n: number): JobSpec =>
  ({ jobId: `job-${n}`, verb: 'bake', payload: {} }) as unknown as JobSpec;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

Deno.test('queue enforces the concurrency limit', async () => {
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 2 });
  const g = gate();
  let concurrent = 0;
  let peak = 0;

  async function* exec(s: JobSpec): AsyncIterable<JobEvent> {
    concurrent++;
    peak = Math.max(peak, concurrent);
    yield { t: 'started', jobId: s.jobId, at };
    await g.opened;
    concurrent--;
    yield { t: 'done', jobId: s.jobId, at, wallTimeS: 0 };
  }

  const handles = [1, 2, 3, 4].map((n) => queue.submit(spec(n), exec));
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(peak, 2, 'only two executors admitted while gated');
  g.open();
  const outcomes = await Promise.all(handles.map((h) => h.done));
  assert(outcomes.every((o) => o.kind === 'done'));
  assertEquals(peak, 2);
});

Deno.test('retry-on-retryable is bounded; non-retryable never retries', async () => {
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 1, maxRetries: 2 });

  let alwaysAttempts = 0;
  async function* alwaysRetryable(s: JobSpec): AsyncIterable<JobEvent> {
    alwaysAttempts++;
    yield { t: 'started', jobId: s.jobId, at };
    yield { t: 'error', jobId: s.jobId, at, code: 'flaky', message: 'nope', retryable: true };
  }
  const o1 = await queue.submit(spec(1), alwaysRetryable).done;
  assertEquals(o1.kind, 'error');
  assertEquals(o1.attempts, 3, '1 initial + maxRetries(2)');
  assertEquals(alwaysAttempts, 3);

  let fatalAttempts = 0;
  async function* fatal(s: JobSpec): AsyncIterable<JobEvent> {
    fatalAttempts++;
    yield { t: 'started', jobId: s.jobId, at };
    yield { t: 'error', jobId: s.jobId, at, code: 'fatal', message: 'no', retryable: false };
  }
  const o2 = await queue.submit(spec(2), fatal).done;
  assertEquals(o2.kind, 'error');
  assertEquals(fatalAttempts, 1);
});

Deno.test('cancel before start emits a terminal cancelled error', async () => {
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 1 });
  const g = gate();

  async function* blocker(s: JobSpec): AsyncIterable<JobEvent> {
    yield { t: 'started', jobId: s.jobId, at };
    await g.opened;
    yield { t: 'done', jobId: s.jobId, at, wallTimeS: 0 };
  }
  const running = queue.submit(spec(1), blocker);
  await new Promise((r) => setTimeout(r, 5));
  const waiting = queue.submit(spec(2), blocker);
  waiting.cancel();
  const o = await waiting.done;
  assertEquals(o.kind, 'cancelled');
  assertEquals(o.error?.code, 'cancelled');
  g.open();
  assertEquals((await running.done).kind, 'done');
  const types = bus.ring.snapshot().filter((e) => e.jobId === 'job-2').map((e) => e.t);
  assertEquals(types, ['queued', 'error']);
});

Deno.test('cancel during run aborts the executor', async () => {
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 1 });
  const g = gate();

  async function* abortable(s: JobSpec, signal: AbortSignal): AsyncIterable<JobEvent> {
    yield { t: 'started', jobId: s.jobId, at };
    await g.opened;
    if (signal.aborted) {
      yield {
        t: 'error',
        jobId: s.jobId,
        at,
        code: 'cancelled',
        message: 'aborted',
        retryable: false,
      };
      return;
    }
    yield { t: 'done', jobId: s.jobId, at, wallTimeS: 0 };
  }
  const h = queue.submit(spec(1), abortable);
  await new Promise((r) => setTimeout(r, 5));
  h.cancel();
  g.open();
  const o = await h.done;
  assertEquals(o.kind, 'cancelled');
  assertEquals(o.attempts, 1);
});

Deno.test('executor throw becomes a non-retryable error event', async () => {
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 1 });
  // deno-lint-ignore require-yield
  async function* boom(s: JobSpec): AsyncIterable<JobEvent> {
    throw new Error(`kaboom in ${s.jobId}`);
  }
  const o = await queue.submit(spec(1), boom).done;
  assertEquals(o.kind, 'error');
  assertEquals(o.error?.code, 'executor-throw');
  assert(o.error?.message.includes('kaboom'));
});
