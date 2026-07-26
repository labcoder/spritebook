import { assert, assertEquals } from 'jsr:@std/assert@1';
import { canonicalJson, JobEventSchema, parseWith } from '@spritebook/schema';
import { ManifestJournal } from '@spritebook/core';
import { PRESETS } from '@spritebook/style';
import { bakeSpecFromFlags, runCli } from './mod.ts';

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

Deno.test('bake --clips arg validation fails fast, before any GPU work', async () => {
  const base = ['bake', '--model', 'm.glb', '--character', 'c', '--out', 'o', '--json'];
  const cases: Array<[string[], string]> = [
    // valueless --clips must NOT silently bake the legacy idle stub (review F9)
    [[...base, '--clips'], '--clips needs a value'],
    [[...base, '--pack'], '--pack needs a directory'],
    [[...base, '--pack', 'somewhere'], '--pack only applies with --clips'],
    // duplicates fail here, not after a full render (review F4)
    [[...base, '--clips', 'walk-loop:2,walk-loop:4'], 'twice'],
    [[...base, '--clips', 'walk-loop:2@0'], 'speed must be > 0'],
    [[...base, '--clips', 'walk-loop:0'], 'frames must be >= 1'],
    [[...base, '--clips', 'Walk_Loop:2'], 'clip:frames[@speed][!hold]'],
  ];
  for (const [args, needle] of cases) {
    const c = collector();
    assertEquals(await runCli(args, c.io), 1, args.join(' '));
    const e = JSON.parse(c.out[c.out.length - 1]);
    assertEquals(e.t, 'error', args.join(' '));
    assertEquals(e.code, 'bad-args', args.join(' '));
    assert(e.message.includes(needle), `${args.join(' ')}: ${e.message}`);
  }
});

Deno.test('bake --mirror reaches the spec, so D-008 is reachable at all', () => {
  const base = ['bake', '--model', 'm.glb', '--character', 'c', '--out', 'o'];
  const resolved = { model: 'm.glb', character: 'c', out: 'o', style: PRESETS['pixel-8'] };

  // the entire defect in one assertion: BakeJobSpec.mirroring existed, the
  // whole mirror path was implemented and tested, and NO flag set this field -
  // so `bake --mirror` ran a full unmirrored bake and reported `done`
  assertEquals(bakeSpecFromFlags([...base, '--mirror'], resolved).mirroring, true);
  assertEquals(
    bakeSpecFromFlags(base, resolved).mirroring,
    false,
    'D-008 is opt-in and never inferred',
  );

  // the flag must not disturb the rest of the surface it shares a verb with
  const spec = bakeSpecFromFlags(
    [...base, '--mirror', '--frames', '4', '--directions', '4', '--only-invalidated'],
    resolved,
  );
  assertEquals(spec.frames, 4);
  assertEquals(spec.camera.directions, 4);
  assertEquals(spec.onlyInvalidated, true);
});

Deno.test('anim --list finds the bundled pack; --tag filters; --json is one document', async () => {
  const c = collector();
  assertEquals(await runCli(['anim', '--list', '--tag', 'walk', '--json'], c.io), 0);
  assertEquals(c.out.length, 1, 'one JSON document');
  const doc = JSON.parse(c.out[0]);
  assertEquals(doc.pack, 'ual');
  assert(doc.clips.length > 0, 'walk-tagged clips exist');
  assert(
    doc.clips.every((x: { tags: string[] }) => x.tags.includes('walk')),
    'tag filter applies',
  );

  const missing = collector();
  assertEquals(
    await runCli(['anim', '--list', '--packs', 'Z:/no-such-root', '--json'], missing.io),
    1,
  );
  const err = JSON.parse(missing.out[0]);
  assertEquals(err.t, 'error');
  assert(err.message.includes('no-such-root'), 'names the offending root');
});

Deno.test('gen --adjust refuses seed and prototype keys', async () => {
  const base = ['gen', '--character', 'hero', '--workspace', 'ws', '--image', 'i.png', '--json'];
  for (
    const [args, needle] of [
      // --adjust seed=N would be silently overridden by the hoisted seed, and
      // the receipt would then record a DIFFERENT seed than the user typed
      [[...base, '--adjust', 'seed=99'], 'not --adjust seed'],
      [[...base, '--adjust', '__proto__={}'], 'not allowed'],
      [[...base, '--adjust', 'nokey'], 'want key=value'],
    ] as Array<[string[], string]>
  ) {
    const c = collector();
    assertEquals(await runCli(args, c.io), 1, args.join(' '));
    const e = JSON.parse(c.out[c.out.length - 1]);
    assertEquals(e.code, 'bad-args', args.join(' '));
    assert(e.message.includes(needle), `${args.join(' ')}: ${e.message}`);
  }
});
