import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * T3 acceptance: a scripted stub bake emits the full event vocabulary (first
 * occurrences in contract order) and replays identically from the file sink.
 */
import { assert, assertEquals, assertThrows } from '@std/assert';
import { JOB_EVENT_TYPES, JobIdSchema, JobSpecSchema, parseWith } from '@spritebook/schema';
import { decodeEvent, encodeEvent, EventBus, FileSink } from './dist/events.js';
import { JobQueue } from './dist/queue.js';
import { makeStubBake } from './dist/stub-bake.js';

function fixedClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 12, 0, 0, n++)).toISOString();
}

test('acceptance: stub bake emits full vocabulary; sink replays identically', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'sb-core-'));
  const sinkPath = `${dir}/session.ndjson`;
  const now = fixedClock();
  const bus = new EventBus({ sink: new FileSink(sinkPath) });
  const queue = new JobQueue({ bus, concurrency: 1, maxRetries: 1, now });
  const spec = parseWith(JobSpecSchema, {
    jobId: 'bake-1',
    verb: 'bake',
    characterId: 'brave-knight',
    payload: {},
  }, 'JobSpec');

  const { executor } = makeStubBake({ now });
  const outcome = await queue.submit(spec, executor).done;
  bus.close();

  assertEquals(outcome.kind, 'done');
  assertEquals(outcome.attempts, 2, 'retryable error on attempt 1 triggers one retry');

  const events = bus.ring.snapshot();
  const seen = events.map((e) => e.t);
  // full vocabulary present
  assertEquals(new Set(seen), new Set(JOB_EVENT_TYPES));
  // first occurrences appear in contract order
  const firstOccurrence = [...new Set(seen)];
  assertEquals(firstOccurrence, [...JOB_EVENT_TYPES]);
  assertEquals(seen[seen.length - 1], 'done');

  // replay: every sink line decodes + re-encodes byte-identically, and the
  // replayed sequence equals the live session
  const sinkText = await fs.readFile(sinkPath, 'utf8');
  const lines = sinkText.split('\n').filter((l) => l.length > 0);
  assertEquals(lines.length, events.length);
  const replayed = lines.map((line) => {
    const event = decodeEvent(line);
    assertEquals(encodeEvent(event), line + '\n', 'line re-encodes byte-identically');
    return event;
  });
  assertEquals(replayed, events);
});

test('a closed event sink cannot write into a subsequently opened log', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'sb-sinks-'));
  const first = new FileSink(`${dir}/first.ndjson`);
  first.write('first\n');
  first.close();
  const next = new FileSink(`${dir}/next.ndjson`);
  try {
    assertThrows(() => first.write('wrong log\n'), Error, 'closed');
    next.write('next\n');
    next.close();
    assertEquals(await fs.readFile(`${dir}/first.ndjson`, 'utf8'), 'first\n');
    assertEquals(await fs.readFile(`${dir}/next.ndjson`, 'utf8'), 'next\n');
  } finally {
    next.close();
    await fs.rm(dir, { recursive: true });
  }
});

test('ring buffer drops oldest beyond capacity', () => {
  const bus = new EventBus({ ringCapacity: 3 });
  const jobId = parseWith(JobIdSchema, 'job-1', 'jobId');
  const at = '2026-07-12T00:00:00Z';
  for (let i = 1; i <= 5; i++) {
    bus.emit({ t: 'progress', jobId, at, step: 'render', done: i, total: 5 });
  }
  const kept = bus.ring.snapshot().map((e) => (e.t === 'progress' ? e.done : -1));
  assertEquals(kept, [3, 4, 5]);
});

test('EventBus rejects contract violations before they reach any sink', () => {
  const bus = new EventBus();
  let threw = false;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid event tests runtime validation
    bus.emit({ t: 'finished', jobId: 'job-1', at: 'now' } as any);
  } catch (err) {
    threw = true;
    assert(String(err).includes('JobEvent'));
  }
  assert(threw);
  assertEquals(bus.ring.size, 0);
});
