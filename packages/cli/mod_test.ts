import { assert, assertEquals } from 'jsr:@std/assert@1';
import { canonicalJson, JobEventSchema, parseWith } from '@spritebook/schema';
import { CAMERA_PRESETS, ManifestJournal } from '@spritebook/core';
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

/**
 * A workspace whose journal line is a lie: applying it in the named direction
 * deletes a REQUIRED field. The `undo` case is exactly the inverse the
 * pre-2026-07-25 invertOp wrote for an `add` over a key that already existed,
 * but any corrupt or hand-edited journal reaches the same write.
 */
async function setupBadJournal(direction: 'undo' | 'redo') {
  const dir = await Deno.makeTempDir({ prefix: 'sb-cli-bad-' });
  const doc = JSON.parse(
    await Deno.readTextFile(
      new URL('../schema/fixtures/valid/character-manifest.json', import.meta.url),
    ),
  ) as Record<string, unknown>;
  const undoing = direction === 'undo';
  if (undoing) doc.displayName = 'Sir Bravery';
  const patch = {
    seq: 0,
    at: '2026-07-12T00:00:00Z',
    target,
    op: undoing
      ? [{ op: 'add', path: '/displayName', value: 'Sir Bravery' }]
      : [{ op: 'remove', path: '/displayName' }],
    inverse: undoing
      ? [{ op: 'remove', path: '/displayName' }]
      : [{ op: 'add', path: '/displayName', value: 'Brave Knight' }],
    label: 'Rename',
  };
  const manifest = `${dir}/character.json`;
  const bytes = canonicalJson(doc);
  const cursor = `${manifest}.journal.cursor`;
  const at = undoing ? '1' : '0';
  await Deno.writeTextFile(manifest, bytes);
  await Deno.writeTextFile(`${manifest}.journal.ndjson`, canonicalJson(patch));
  await Deno.writeTextFile(cursor, at);
  return { manifest, cursor, bytes, at };
}

for (const verb of ['undo', 'redo'] as const) {
  Deno.test(`cli ${verb} refuses to write an invalid manifest, naming the file`, async () => {
    const w = await setupBadJournal(verb);
    const c = collector();

    assertEquals(await runCli([verb, '--manifest', w.manifest, '--json'], c.io), 1);

    const event = JSON.parse(c.out[c.out.length - 1]);
    assertEquals(event.t, 'error');
    assertEquals(event.code, 'invalid-manifest');
    assert(event.message.includes(w.manifest), `names the manifest: ${event.message}`);
    assert(event.message.includes('displayName'), `and what is wrong: ${event.message}`);
    assertEquals(await Deno.readTextFile(w.manifest), w.bytes, 'the document is untouched');
    assertEquals(await Deno.readTextFile(w.cursor), w.at, 'the cursor did not move');
  });
}

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
    [[...base, '--pack', 'somewhere'], '--pack only applies when there are clips'],
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
  const resolved = { model: 'm.glb', character: 'c', out: 'o' };

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

const RESOLVED = { model: 'm.glb', character: 'c', out: 'o' };

Deno.test('flags and a stored look resolve to the SAME camera (D-029)', () => {
  // The whole reason one resolution path replaced two: the flag defaults used
  // to synthesize a camera whose id (`cli-e30x8`) named no preset anywhere, so
  // a look-driven bake and a flag-driven bake of identical geometry produced
  // different cameraPresetHash values, different bakeIds, and could not share a
  // single cached frame.
  const viaFlags = bakeSpecFromFlags(
    ['bake', '--directions', '2', '--cell', '48'],
    RESOLVED,
  ).camera;
  const viaLook = bakeSpecFromFlags(['bake'], {
    ...RESOLVED,
    look: {
      cameraPresetId: 'standard-30',
      cameraOverrides: { directions: 2, cellPx: { w: 48, h: 48 } },
      stylePresetId: 'pixel-8',
    },
  }).camera;
  assertEquals(canonicalJson(viaFlags), canonicalJson(viaLook));
  assertEquals(viaFlags.id, 'standard-30', 'the id names a preset that resolves');
});

Deno.test('the bake defaults are the standard-30 preset, field for field', () => {
  // The cross-check core/presets_test.ts points at. If either side moves alone,
  // a default bake silently changes framing.
  assertEquals(
    canonicalJson(bakeSpecFromFlags(['bake'], RESOLVED).camera),
    canonicalJson(CAMERA_PRESETS['standard-30']),
  );
  assertEquals(bakeSpecFromFlags(['bake'], RESOLVED).style.id, 'pixel-8');
});

Deno.test('an explicit flag beats the stored look; silence defers to it', () => {
  const look = {
    cameraPresetId: 'isometric',
    cameraOverrides: { directions: 4 as const, paddingPx: 10 },
    stylePresetId: 'cel-2',
  };
  const stored = bakeSpecFromFlags(['bake'], { ...RESOLVED, look });
  assertEquals(stored.camera.id, 'isometric');
  assertEquals(stored.camera.directions, 4);
  assertEquals(stored.camera.paddingPx, 10);
  assertEquals(stored.style.id, 'cel-2');

  const overridden = bakeSpecFromFlags(
    ['bake', '--camera', 'low-15', '--directions', '16', '--style', 'painterly'],
    { ...RESOLVED, look },
  );
  assertEquals(overridden.camera.id, 'low-15');
  assertEquals(overridden.camera.directions, 16);
  assertEquals(
    overridden.camera.paddingPx,
    10,
    'an untouched override still comes from the look - flags refine, they do not replace',
  );
  assertEquals(overridden.style.id, 'painterly');
});

Deno.test('a default is not a decision: unspoken flags do not overwrite a look', () => {
  // `intFlag(args, 'cell', 64)` cannot tell "the user asked for 64" from
  // "nobody said anything". Folding defaults in would silently reset a
  // character's stored cell size on every bake that did not restate it.
  const spec = bakeSpecFromFlags(['bake'], {
    ...RESOLVED,
    look: {
      cameraPresetId: 'standard-30',
      cameraOverrides: { cellPx: { w: 128, h: 128 }, pixelsPerMeter: 64, elevationDeg: 22 },
      stylePresetId: 'pixel-8',
    },
  });
  assertEquals(spec.camera.cellPx, { w: 128, h: 128 });
  assertEquals(spec.camera.pixelsPerMeter, 64);
  assertEquals(spec.camera.elevationDeg, 22);
});

Deno.test("a character's own clips drive the bake, disabled ones excepted", () => {
  const animationSet = [
    { clipId: 'walk-loop', packId: 'ual', enabled: true, frames: 6, speed: 1.5, holdLast: false },
    { clipId: 'idle-loop', packId: 'ual', enabled: false, frames: 4, speed: 1, holdLast: false },
  ];
  const spec = bakeSpecFromFlags(['bake'], { ...RESOLVED, animationSet });
  assertEquals(spec.clips, [{ clipId: 'walk-loop', frames: 6, speed: 1.5, holdLast: false }]);

  // `enabled: false` is the user saying "not this one" — baking it at its
  // stored frame count would render a clip they had switched off
  assertEquals(
    bakeSpecFromFlags(['bake'], {
      ...RESOLVED,
      animationSet: [{ ...animationSet[1] }],
    }).clips,
    undefined,
    'nothing enabled -> the idle-stub bake, not an empty clip list',
  );

  // and --clips still wins outright
  assertEquals(
    bakeSpecFromFlags(['bake', '--clips', 'run-loop:3'], { ...RESOLVED, animationSet })
      .clips,
    [{ clipId: 'run-loop', frames: 3, speed: 1, holdLast: false }],
  );
});

Deno.test('a look naming a preset that does not exist says which one, and where from', async () => {
  const ws = await Deno.makeTempDir({ prefix: 'sb-look-' });
  try {
    const { createWorkspace, recordBake } = await import('@spritebook/core');
    await createWorkspace({
      workspace: ws,
      characterId: 'brave-knight',
      displayName: 'Brave Knight',
      source: { kind: 'image', originalFilename: 'k.png', sha256: 'a'.repeat(64) },
      now,
    });
    await recordBake(ws, {
      look: { cameraPresetId: 'topdown30x8', stylePresetId: 'pixel-8' },
      lastBakeId: 'aaaaaaaa',
    }, { now });

    const c = collector();
    assertEquals(await runCli(['bake', '--workspace', ws, '--json'], c.io), 1);
    const e = JSON.parse(c.out[c.out.length - 1]);
    assertEquals(e.code, 'unknown-camera');
    assert(e.message.includes('topdown30x8'), e.message);
    assert(e.message.includes("from the character's look"), e.message);
    assert(e.message.includes('standard-30'), 'names what it could have been');
  } finally {
    await Deno.remove(ws, { recursive: true });
  }
});

Deno.test('an unsupported flag is an error event, never silent success', async () => {
  const bake = ['bake', '--model', 'm.glb', '--character', 'c', '--out', 'o'];
  const cases: Array<[string[], string]> = [
    // THE defect: --mirror was unsupported, so this ran a full unmirrored bake
    // at full GPU cost and printed `done`. Any unsupported flag must refuse.
    [[...bake, '--mirrror'], '--mirrror'],
    [[...bake, '--framse', '4'], '--framse'],
    [['export', '--bake', 'b', '--out', 'o', '--targets', 'godot', '--nope'], '--nope'],
    [['undo', '--manifest', 'm', '--force'], '--force'],
    [['anim', '--list', '--tags', 'walk'], '--tags'],
    [['doctor', '--verbose'], '--verbose'],
    // `--cell=64` is not a value the CLI can read: flag() takes space-separated
    // values, so before this check it silently baked at the default 64px cell
    [[...bake, '--cell=32'], 'space-separated'],
  ];
  for (const [args, needle] of cases) {
    const c = collector();
    assertEquals(await runCli([...args, '--json'], c.io), 1, args.join(' '));
    const e = JSON.parse(c.out[c.out.length - 1]);
    // --json must yield a JobEvent, not a stack trace
    parseWith(JobEventSchema, e, 'cli NDJSON line');
    assertEquals(e.t, 'error', args.join(' '));
    assertEquals(e.code, 'unknown-flag', args.join(' '));
    assert(e.message.includes(needle), `${args.join(' ')}: ${e.message}`);
  }

  // and the message says what the verb DOES take
  const listed = collector();
  await runCli([...bake, '--mirrror', '--json'], listed.io);
  assert(JSON.parse(listed.out[0]).message.includes('--mirror'), 'names the real flag');
});

Deno.test('flag checking does not fire on flags the verbs legitimately take', async () => {
  // the guard must not become a second place where a real flag goes missing:
  // every flag reaching a real code path has to survive the gate
  const ok: string[][] = [
    ['bake', '--model', 'nope.glb', '--character', 'c', '--out', 'o', '--mirror'],
    ['bake', '--model', 'nope.glb', '--character', 'c', '--out', 'o', '--clips', 'walk-loop:2'],
    ['bake', '--model', 'nope.glb', '--character', 'c', '--out', 'o', '--only-invalidated'],
  ];
  for (const args of ok) {
    const c = collector();
    await runCli([...args, '--json'], c.io);
    const codes = c.out.map((l) => JSON.parse(l).code).filter(Boolean);
    assert(!codes.includes('unknown-flag'), `${args.join(' ')} -> ${codes.join(',')}`);
    // it got as far as the job and failed on the missing model, not on parsing
    assert(codes.includes('bake-failed'), `${args.join(' ')} reached the bake: ${codes.join(',')}`);
  }

  // an unknown VERB keeps its own, more useful message
  const badVerb = collector();
  assertEquals(await runCli(['transmogrify', '--wat'], badVerb.io), 1);
  assert(badVerb.err[0].includes('Unknown verb'), badVerb.err[0]);

  // and a prototype-chain verb name must not crash the lookup
  const proto = collector();
  assertEquals(await runCli(['constructor', '--wat'], proto.io), 1);
  assert(proto.err[0].includes('Unknown verb'), proto.err[0]);
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
