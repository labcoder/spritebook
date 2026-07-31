/**
 * The --log-append sink (P4-T2): every JobEvent lands in the file as NDJSON
 * regardless of output mode, an unwritable sink warns once and never kills
 * the job, and the studio's drawer can replay what landed. The sink carries
 * JOB EVENTS — query snapshots (doctor, models list) are documents and stay
 * out, which this test pins so the contract is deliberate, not accidental.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { runCli } from './mod.ts';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    out,
    err,
  };
}

Deno.test('events tee to the sink as NDJSON even WITHOUT --json', async () => {
  const tmp = await Deno.makeTempDir();
  const sink = `${tmp}/session.ndjsonl`;
  try {
    // a cheap, deterministic failure: undo with a missing manifest
    const o = io();
    const code = await runCli(
      ['undo', '--manifest', `${tmp}/nope/character.json`, '--log-append', sink],
      o,
    );
    assertEquals(code, 1);
    const lines = (await Deno.readTextFile(sink)).trim().split('\n');
    // the full stream lands, not a summary: queued, started, then the error
    assertEquals(lines.map((l) => JSON.parse(l).t), ['queued', 'started', 'error']);
    const e = JSON.parse(lines.at(-1)!);
    assert(typeof e.code === 'string' && typeof e.at === 'string', 'a real JobEvent landed');
    // and the TERMINAL stayed human (no JSON on stdout without --json)
    assert(!o.out.some((l) => l.startsWith('{')), 'stdout stays human without --json');
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test('the sink APPENDS across runs — a session file accumulates', async () => {
  const tmp = await Deno.makeTempDir();
  const sink = `${tmp}/session.ndjsonl`;
  try {
    await runCli(['undo', '--manifest', `${tmp}/a/character.json`, '--log-append', sink], io());
    const afterOne = (await Deno.readTextFile(sink)).trim().split('\n').length;
    await runCli(['redo', '--manifest', `${tmp}/b/character.json`, '--log-append', sink], io());
    const afterTwo = (await Deno.readTextFile(sink)).trim().split('\n').length;
    assertEquals(afterTwo, afterOne * 2, 'the second run APPENDED, not replaced');
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test('an unwritable sink warns on stderr and the run continues', async () => {
  const o = io();
  // a directory path is never writable as a file
  const code = await runCli(
    ['undo', '--manifest', 'nope/character.json', '--log-append', '.'],
    o,
  );
  assertEquals(code, 1, 'the verb still ran to its own failure');
  assert(o.err.some((l) => l.includes('--log-append')), 'the sink failure is named once');
});

Deno.test('query snapshots stay OUT of the sink — it is a job-event stream', async () => {
  const tmp = await Deno.makeTempDir();
  const sink = `${tmp}/session.ndjsonl`;
  try {
    const code = await runCli(['models', 'list', '--json', '--log-append', sink], io());
    assertEquals(code, 0);
    const exists = await Deno.stat(sink).then(() => true, () => false);
    assertEquals(exists, false, 'a list document is not a job event');
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
