/**
 * The session log's contract: severity is DERIVED from the line (JobEvent
 * `t`, or a doctor-style `error` field), never rewritten; the store caps as
 * a tail; the unseen-error badge counts until the drawer is opened.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { LOG_CAP, LogStore, severityOf } from './src/log.ts';

Deno.test('severity: JobEvent t wins; doctor error field is an error; junk is info', () => {
  assertEquals(severityOf(JSON.stringify({ t: 'error', code: 'x' })), 'error');
  assertEquals(severityOf(JSON.stringify({ t: 'warn', code: 'x' })), 'warn');
  assertEquals(severityOf(JSON.stringify({ t: 'progress' })), 'info');
  assertEquals(severityOf(JSON.stringify({ spritebook: '1', error: 'no adapter' })), 'error');
  assertEquals(severityOf(JSON.stringify({ spritebook: '1', probe: { ok: true } })), 'info');
  assertEquals(severityOf('not json at all'), 'info');
  assertEquals(severityOf('null'), 'info');
  assertEquals(severityOf('42'), 'info');
});

Deno.test('the store is a tail: the cap drops the OLDEST lines', () => {
  const s = new LogStore();
  for (let i = 0; i < LOG_CAP + 10; i++) s.append('job', `line ${i}`);
  const { lines } = s.snapshot();
  assertEquals(lines.length, LOG_CAP);
  assertEquals(lines[0]!.line, 'line 10', 'the first 10 fell off');
  assertEquals(lines.at(-1)!.line, `line ${LOG_CAP + 9}`);
});

Deno.test('the badge counts errors until seen, then starts over', () => {
  const s = new LogStore();
  s.append('a', JSON.stringify({ t: 'error' }));
  s.append('a', 'plain line');
  s.append('b', JSON.stringify({ t: 'error' }));
  assertEquals(s.snapshot().unseenErrors, 2);
  s.markSeen();
  assertEquals(s.snapshot().unseenErrors, 0);
  s.append('c', JSON.stringify({ t: 'error' }));
  assertEquals(s.snapshot().unseenErrors, 1);
});

Deno.test('subscribers fire per append and the snapshot is stable between them', () => {
  const s = new LogStore();
  let fired = 0;
  const un = s.subscribe(() => fired++);
  const snapA = s.snapshot();
  assertEquals(s.snapshot(), snapA, 'same reference between appends');
  s.append('a', 'x');
  assert(fired === 1);
  un();
  s.append('a', 'y');
  assertEquals(fired, 1, 'unsubscribed');
});

Deno.test('stderr stays verbatim, separate from stdout, and contributes to the error badge', () => {
  const s = new LogStore();
  const raw = 'Traceback: worker process crashed';
  s.append('job', '{"t":"progress"}', 1);
  s.append('job', raw, 2, 'stderr');
  assertEquals(s.snapshot().lines.map((l) => [l.stream, l.line]), [
    ['stdout', '{"t":"progress"}'],
    ['stderr', raw],
  ]);
  assertEquals(s.snapshot().unseenErrors, 1);
});
