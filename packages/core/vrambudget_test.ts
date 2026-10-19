import { test } from 'node:test';
/**
 * The queue's VRAM budget (P4-T3).
 *
 * A job count is the wrong unit for sidecar work: two 16 GiB jobs fit
 * "concurrency 2" and OOM a 24 GiB card. These tests are about the three ways
 * a budget can be wrong in a way nobody notices until 3am —
 *
 *   over-admission   two jobs whose claims exceed the budget both start
 *   starvation       a large job never runs because small ones keep passing it
 *   a leaked claim   a failed/cancelled job's GiB is never given back, and the
 *                    queue quietly runs less work every cycle until it stops
 *
 * plus the one that is merely rude: holding work with no way to see why.
 */
import { assert, assertEquals } from '@std/assert';
import type { JobEvent, JobSpec } from '@spritebook/schema';
import { EventBus } from './dist/events.js';
import { JobQueue } from './dist/queue.js';

const at = '2026-08-01T00:00:00Z';
const spec = (id: string): JobSpec =>
  ({ jobId: id, verb: 'gen', payload: {} }) as unknown as JobSpec;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

/**
 * An executor that reports when it starts and blocks until its gate opens —
 * or until it is cancelled, which it must observe: an executor that ignores
 * its signal holds its VRAM claim forever, and this file is about claims
 * coming back.
 */
function held(started: string[], g: { opened: Promise<void> }) {
  return async function* (s: JobSpec, signal: AbortSignal): AsyncIterable<JobEvent> {
    started.push(s.jobId);
    yield { t: 'started', jobId: s.jobId, at };
    await Promise.race([
      g.opened,
      new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })),
    ]);
    if (signal.aborted) return;
    yield { t: 'done', jobId: s.jobId, at, wallTimeS: 0 };
  };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test('the budget admits what fits and holds what does not', async () => {
  const bus = new EventBus();
  // concurrency alone would run all three; the card would not
  const queue = new JobQueue({ bus, concurrency: 4, vramBudgetGb: 24 });
  const started: string[] = [];
  const g = gate();
  const exec = held(started, g);

  const handles = [
    queue.submit(spec('trellis-a'), exec, { vramGb: 16 }),
    queue.submit(spec('trellis-b'), exec, { vramGb: 16 }),
    queue.submit(spec('rembg'), exec, { vramGb: 0.5 }),
  ];
  await tick();
  assertEquals(started, ['trellis-a'], 'the second 16 GiB job does not fit beside the first');
  assertEquals(queue.vramCommittedGb, 16);

  g.open();
  const outcomes = await Promise.all(handles.map((h) => h.done));
  assert(outcomes.every((o) => o.kind === 'done'), 'and they all run, in order');
  assertEquals(started, ['trellis-a', 'trellis-b', 'rembg']);
  assertEquals(queue.vramCommittedGb, 0, 'every claim was given back');
});

test('a big job is NOT starved by a stream of small ones', async () => {
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 8, vramBudgetGb: 24 });
  const started: string[] = [];
  const blocker = gate();
  const rest = gate();

  // an 8 GiB job runs first, leaving 16 GiB free. Then a 20 GiB job that does
  // NOT fit in what is left, and behind it twenty 1 GiB jobs that all would.
  // A "start whatever fits" scheduler runs all twenty and makes the big job
  // wait for every one of them; FIFO admission makes them wait for it.
  const handles = [queue.submit(spec('blocker'), held(started, blocker), { vramGb: 8 })];
  handles.push(queue.submit(spec('big'), held(started, rest), { vramGb: 20 }));
  for (let i = 0; i < 20; i++) {
    handles.push(queue.submit(spec(`small-${i}`), held(started, rest), { vramGb: 1 }));
  }
  await tick();
  assertEquals(started, ['blocker'], 'nothing is promoted past the job that does not fit');
  assert(queue.blockedReason()!.includes('big needs 20 GiB'), queue.blockedReason()!);

  blocker.open();
  await tick();
  assertEquals(started[1], 'big', 'the big job goes the moment its turn can be honoured');
  rest.open();
  await Promise.all(handles.map((h) => h.done));
  assertEquals(started.length, 22, 'and every job ran');
  assertEquals(queue.vramCommittedGb, 0);
});

test('waiting on VRAM is SAID, once, on the bus', async () => {
  // a queue deliberately holding work looks exactly like a hung one
  const bus = new EventBus();
  const warns: Extract<JobEvent, { t: 'warn' }>[] = [];
  bus.listen((e) => {
    if (e.t === 'warn') warns.push(e);
  });
  const queue = new JobQueue({ bus, concurrency: 4, vramBudgetGb: 24 });
  const started: string[] = [];
  const g = gate();

  const handles = [
    queue.submit(spec('a'), held(started, g), { vramGb: 16 }),
    queue.submit(spec('b'), held(started, g), { vramGb: 16 }),
  ];
  await tick();
  assertEquals(warns.length, 1, 'said once, not once per pump');
  assertEquals(warns[0]!.code, 'vram-wait');
  assertEquals(warns[0]!.jobId, 'b');
  assert(warns[0]!.message.includes('16 GiB'), warns[0]!.message);
  assert(warns[0]!.message.includes('8 GiB'), `names what is free: ${warns[0]!.message}`);

  const reason = queue.blockedReason();
  assert(reason !== null && reason.includes('b needs 16 GiB'), `${reason}`);

  g.open();
  await Promise.all(handles.map((h) => h.done));
  assertEquals(queue.blockedReason(), null, 'and stops saying it once it is not true');
});

test('a claim bigger than the whole budget is refused, not queued', async () => {
  // queuing it would hang forever AND block everything behind it under FIFO
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 2, vramBudgetGb: 12 });
  const started: string[] = [];
  const g = gate();

  const impossible = queue.submit(spec('hunyuan'), held(started, g), { vramGb: 16 });
  const outcome = await impossible.done;
  assertEquals(outcome.kind, 'error');
  assertEquals(outcome.error!.code, 'vram-budget-exceeded');
  assert(outcome.error!.message.includes('16 GiB'), outcome.error!.message);
  assert(outcome.error!.message.includes('12 GiB'), outcome.error!.message);
  assertEquals(started, [], 'it never started');

  // and the queue is not poisoned: the next job runs
  const fine = queue.submit(spec('ok'), held(started, g), { vramGb: 8 });
  await tick();
  assertEquals(started, ['ok']);
  g.open();
  assertEquals((await fine.done).kind, 'done');
});

test('a failed, thrown, or cancelled job gives its VRAM back', async () => {
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 1, vramBudgetGb: 24, maxRetries: 0 });

  // eslint-disable-next-line require-yield
  async function* fails(s: JobSpec): AsyncIterable<JobEvent> {
    yield { t: 'started', jobId: s.jobId, at };
    yield {
      t: 'error',
      jobId: s.jobId,
      at,
      code: 'oom',
      message: 'out of memory',
      retryable: false,
    };
  }
  async function* throws(s: JobSpec): AsyncIterable<JobEvent> {
    yield { t: 'started', jobId: s.jobId, at };
    throw new Error('the sidecar died');
  }
  assertEquals((await queue.submit(spec('e1'), fails, { vramGb: 16 }).done).kind, 'error');
  assertEquals(queue.vramCommittedGb, 0, 'an error released it');
  assertEquals((await queue.submit(spec('e2'), throws, { vramGb: 16 }).done).kind, 'error');
  assertEquals(queue.vramCommittedGb, 0, 'a throw released it');

  const g = gate();
  const started: string[] = [];
  const h = queue.submit(spec('e3'), held(started, g), { vramGb: 16 });
  await tick();
  assertEquals(queue.vramCommittedGb, 16);
  h.cancel();
  assertEquals((await h.done).kind, 'cancelled');
  assertEquals(queue.vramCommittedGb, 0, 'a cancel released it');

  // the proof that nothing leaked: a 24 GiB job still fits afterwards
  const last = queue.submit(spec('full'), held(started, g), { vramGb: 24 });
  await tick();
  assert(started.includes('full'), 'the budget is whole again');
  g.open();
  await last.done;
});

test('no budget means no budgeting — a claim is just ignored', async () => {
  // the honest default when detection returned null: an invented budget would
  // refuse work the card can actually do
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 3 });
  const started: string[] = [];
  const g = gate();
  const handles = [1, 2, 3].map((n) =>
    queue.submit(spec(`j${n}`), held(started, g), { vramGb: 999 })
  );
  await tick();
  assertEquals(started.length, 3, 'concurrency is the only gate');
  assertEquals(queue.blockedReason(), null);
  g.open();
  await Promise.all(handles.map((h) => h.done));
});

test('a job with no claim is gated by concurrency alone', async () => {
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 2, vramBudgetGb: 8 });
  const started: string[] = [];
  const g = gate();
  // rembg is a CPU sidecar: it holds no VRAM and must not wait behind one
  const handles = [
    queue.submit(spec('cpu-a'), held(started, g)),
    queue.submit(spec('cpu-b'), held(started, g), { vramGb: 0 }),
    queue.submit(spec('cpu-c'), held(started, g)),
  ];
  await tick();
  assertEquals(started, ['cpu-a', 'cpu-b']);
  assertEquals(queue.vramCommittedGb, 0);
  g.open();
  await Promise.all(handles.map((h) => h.done));
});

test('fractional GiB do not drift the budget below zero', async () => {
  // nvidia-smi reports one decimal, and repeated float subtraction is how a
  // budget silently becomes 23.999999999999996 and then refuses a 24 GiB job
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 1, vramBudgetGb: 23.6 });
  const started: string[] = [];
  const g = gate();
  const handles = [
    queue.submit(spec('a'), held(started, g), { vramGb: 7.9 }),
    queue.submit(spec('b'), held(started, g), { vramGb: 15.7 }),
    queue.submit(spec('c'), held(started, g), { vramGb: 23.6 }),
  ];
  g.open();
  await Promise.all(handles.map((h) => h.done));
  assertEquals(queue.vramCommittedGb, 0, 'exactly zero, not 4e-16');
  assertEquals(started.length, 3, 'including the job that needs the entire budget');
});
