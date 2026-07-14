import { assert, assertEquals } from 'jsr:@std/assert@1';
import { canonicalJson, JobEventSchema, parseWith } from '@spritebook/schema';
import { ManifestJournal } from '@spritebook/core';
import { runCli } from './mod.ts';

const now = () => '2026-07-12T00:00:00Z';
const target = { kind: 'character', id: 'brave-knight' } as const;

/** Set up a manifest + journal on disk exactly as core writes them. */
async function setupWorkspace(): Promise<{ manifest: string; original: string }> {
  const dir = await Deno.makeTempDir({ prefix: 'sb-cli-' });
  const original = JSON.parse(
    await Deno.readTextFile(
      new URL('../schema/fixtures/valid/character-manifest.json', import.meta.url),
    ),
  );
  const originalBytes = canonicalJson(original);
  const journal = new ManifestJournal(original, { now });
  const patches = [
    journal.commit({
      target,
      op: [{ op: 'replace', path: '/displayName', value: 'Sir Bravery' }],
      label: 'Rename',
    }),
    journal.commit({
      target,
      op: [{ op: 'replace', path: '/mirroring/enabled', value: true }],
      label: 'Enable mirroring',
    }),
  ];
  const manifest = `${dir}/character.json`;
  await Deno.writeTextFile(manifest, journal.canonicalBytes);
  await Deno.writeTextFile(
    `${manifest}.journal.ndjson`,
    patches.map((p) => canonicalJson(p)).join(''),
  );
  return { manifest, original: originalBytes };
}

function collector() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l), now },
    out,
    err,
  };
}

Deno.test('cli undo/redo restore and reapply patches; --json emits valid NDJSON', async () => {
  const { manifest, original } = await setupWorkspace();
  const afterBoth = await Deno.readTextFile(manifest);

  // undo twice -> byte-identical original
  for (let i = 0; i < 2; i++) {
    const c = collector();
    const code = await runCli(['undo', '--manifest', manifest, '--json'], c.io);
    assertEquals(code, 0);
    for (const line of c.out) parseWith(JobEventSchema, JSON.parse(line), 'cli NDJSON line');
    assertEquals(c.out.length, 4, 'queued, started, artifact, done');
  }
  assertEquals(await Deno.readTextFile(manifest), original);

  // a third undo has nothing left - error event, exit 1
  const spent = collector();
  assertEquals(await runCli(['undo', '--manifest', manifest, '--json'], spent.io), 1);
  const errEvent = JSON.parse(spent.out[spent.out.length - 1]);
  assertEquals(errEvent.t, 'error');
  assertEquals(errEvent.code, 'nothing-to-undo');

  // redo twice -> back to the post-patch state
  for (let i = 0; i < 2; i++) {
    const c = collector();
    assertEquals(await runCli(['redo', '--manifest', manifest, '--json'], c.io), 0);
  }
  assertEquals(await Deno.readTextFile(manifest), afterBoth);
});

Deno.test('cli without --json stays human-readable; unknown verbs fail actionably', async () => {
  const { manifest } = await setupWorkspace();
  const human = collector();
  assertEquals(await runCli(['undo', '--manifest', manifest], human.io), 0);
  assert(human.out.some((l) => l.includes('undid: Enable mirroring')));
  assert(human.out.every((l) => !l.startsWith('{')), 'no JSON without --json');

  const bad = collector();
  assertEquals(await runCli(['transmogrify'], bad.io), 1);
  assert(bad.err[0].includes('Unknown verb'));

  const missing = collector();
  assertEquals(await runCli(['undo'], missing.io), 1);
  assert(missing.err[0].includes('--manifest'));
});
