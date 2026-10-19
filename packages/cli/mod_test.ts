import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { canonicalJson, JobEventSchema, parseWith } from '@spritebook/schema';
import { CAMERA_PRESETS, ManifestJournal } from '@spritebook/core';
import { bakeSpecFromFlags, mergeAnimationSet, mirroringFor, provenanceOf, runCli } from './dist/mod.js';

const now = () => '2026-07-12T00:00:00Z';
const target = { kind: 'character', id: 'brave-knight' } as const;

/** Set up a manifest + journal on disk exactly as core writes them. */
async function setupWorkspace(): Promise<{ manifest: string; original: string }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'sb-cli-'));
  const original = JSON.parse(
    await fs.readFile(new URL('../schema/fixtures/valid/character-manifest.json', import.meta.url), 'utf8'),
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
  await fs.writeFile(manifest, journal.canonicalBytes);
  await fs.writeFile(
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

test('cli undo/redo restore and reapply patches; --json emits valid NDJSON', async () => {
  const { manifest, original } = await setupWorkspace();
  const afterBoth = await fs.readFile(manifest, 'utf8');

  // undo twice -> byte-identical original
  for (let i = 0; i < 2; i++) {
    const c = collector();
    const code = await runCli(['undo', '--manifest', manifest, '--json'], c.io);
    assertEquals(code, 0);
    for (const line of c.out) parseWith(JobEventSchema, JSON.parse(line), 'cli NDJSON line');
    assertEquals(c.out.length, 4, 'queued, started, artifact, done');
  }
  assertEquals(await fs.readFile(manifest, 'utf8'), original);

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
  assertEquals(await fs.readFile(manifest, 'utf8'), afterBoth);
});

/**
 * A workspace whose journal line is a lie: applying it in the named direction
 * deletes a REQUIRED field. The `undo` case is exactly the inverse the
 * pre-2026-07-25 invertOp wrote for an `add` over a key that already existed,
 * but any corrupt or hand-edited journal reaches the same write.
 */
async function setupBadJournal(direction: 'undo' | 'redo') {
  const dir = await fs.mkdtemp(join(tmpdir(), 'sb-cli-bad-'));
  const doc = JSON.parse(
    await fs.readFile(new URL('../schema/fixtures/valid/character-manifest.json', import.meta.url), 'utf8'),
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
  await fs.writeFile(manifest, bytes);
  await fs.writeFile(`${manifest}.journal.ndjson`, canonicalJson(patch));
  await fs.writeFile(cursor, at);
  return { manifest, cursor, bytes, at };
}

for (const verb of ['undo', 'redo'] as const) {
  test(`cli ${verb} refuses to write an invalid manifest, naming the file`, async () => {
    const w = await setupBadJournal(verb);
    const c = collector();

    assertEquals(await runCli([verb, '--manifest', w.manifest, '--json'], c.io), 1);

    const event = JSON.parse(c.out[c.out.length - 1]);
    assertEquals(event.t, 'error');
    assertEquals(event.code, 'invalid-manifest');
    assert(event.message.includes(w.manifest), `names the manifest: ${event.message}`);
    assert(event.message.includes('displayName'), `and what is wrong: ${event.message}`);
    assertEquals(await fs.readFile(w.manifest, 'utf8'), w.bytes, 'the document is untouched');
    assertEquals(await fs.readFile(w.cursor, 'utf8'), w.at, 'the cursor did not move');
  });
}

test('cli without --json stays human-readable; unknown verbs fail actionably', async () => {
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

test('undo works on a workspace written by an older build', async () => {
  // Without the migration at readJournal, `undo` applies the inverse to a v2
  // document and manifestFault then refuses the RESULT for being v2 - a verb
  // whose entire promise is "put it back", failing on a document whose only
  // fault is being old.
  const dir = await fs.mkdtemp(join(tmpdir(), 'sb-cli-v2-'));
  try {
    const v3 = JSON.parse(
      await fs.readFile(new URL('../schema/fixtures/valid/character-manifest.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    // wind the fixture back to what a pre-D-029 build wrote
    const v2 = {
      ...v3,
      schemaVersion: 2,
      preflight: { at: now(), checks: [{ id: 'cutout', status: 'ok', message: 'Clean' }] },
      displayName: 'Sir Bravery',
    };
    const manifest = `${dir}/character.json`;
    await fs.writeFile(manifest, canonicalJson(v2));
    await fs.writeFile(
      `${manifest}.journal.ndjson`,
      canonicalJson({
        seq: 0,
        at: now(),
        target,
        op: [{ op: 'replace', path: '/displayName', value: 'Sir Bravery' }],
        inverse: [{ op: 'replace', path: '/displayName', value: 'Brave Knight' }],
        label: 'Rename',
      }),
    );
    await fs.writeFile(`${manifest}.journal.cursor`, '1');

    const c = collector();
    assertEquals(await runCli(['undo', '--manifest', manifest, '--json'], c.io), 0, c.err.join(''));
    const after = JSON.parse(await fs.readFile(manifest, 'utf8'));
    assertEquals(after.displayName, 'Brave Knight', 'the undo did what it said');
    assertEquals(after.schemaVersion, 3, 'and the write persisted the upgrade');
    assertEquals(after.preflight, undefined);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('bake --clips arg validation fails fast, before any GPU work', async () => {
  const base = ['bake', '--model', 'm.glb', '--character', 'c', '--out', 'o', '--json'];
  const cases: Array<[string[], string]> = [
    // valueless --clips must NOT silently bake the legacy idle stub (review F9)
    [[...base, '--clips'], '--clips needs a value'],
    [[...base, '--pack'], '--pack needs a value'],
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

test('--seed 0 is a seed, not a bad argument', async (t) => {
  const workspace = await fs.mkdtemp(join(tmpdir(), 'sb-cli-args-'));
  t.after(() => fs.rm(workspace, { recursive: true }));
  // Found by running `retexture --seed 0` for real: every verb taking a seed
  // ran it through the POSITIVE-integer helper, so 0 was refused as
  // "must be a positive integer" — while GenAdapterParamsSchema says
  // nonnegative() and the catalog's own default seed is literally 0. A user
  // reproducing a documented run could not type the seed it names.
  const zero = ['retexture', '--workspace', workspace, '--result', 'r1', '--seed', '0', '--json'];
  const c = collector();
  await runCli(zero, c.io);
  const first = JSON.parse(c.out[c.out.length - 1]);
  assert(
    !(first.t === 'error' && String(first.message).includes('positive integer')),
    `--seed 0 must survive parsing: ${JSON.stringify(first)}`,
  );

  // and the rule that IS right still holds, with a message that states it.
  // `gen` because it parses its seed before touching disk, so the refusal here
  // is the parse and not a missing workspace.
  for (const bad of ['-1', '1.5']) {
    const c2 = collector();
    const args = ['gen', '--workspace', workspace, '--character', 'c', '--image', 'i.png', '--seed'];
    assertEquals(await runCli([...args, bad, '--json'], c2.io), 1, bad);
    const e = JSON.parse(c2.out[c2.out.length - 1]);
    assertEquals(e.code, 'bad-args', bad);
    assert(e.message.includes('non-negative integer'), `${bad}: ${e.message}`);
  }
});

test('mirroring: the flags beat the stored choice, which beats off', () => {
  const on = ['bake', '--mirror'];
  const off = ['bake', '--no-mirror'];
  const silent = ['bake'];

  // nothing said, nothing stored -> off. D-008's default, unchanged.
  assertEquals(mirroringFor(silent, undefined), false);
  assertEquals(mirroringFor(silent, false), false);
  // THE wiring: a character that has already said yes bakes mirrored with no
  // flag at all. `mirroring.enabled` had a schema, a writer in createWorkspace
  // and a cache-key story, and the bake read none of it.
  assertEquals(mirroringFor(silent, true), true);

  // and either flag overrides whatever is stored, in both directions
  assertEquals(mirroringFor(on, false), true);
  assertEquals(mirroringFor(on, true), true);
  assertEquals(mirroringFor(off, true), false, '--no-mirror is how a yes says no for one bake');
  assertEquals(mirroringFor(off, false), false);
});

test('mirroring reaches the SPEC from the stored choice, not just the flag', () => {
  const base = ['bake'];
  const resolved = { model: 'm.glb', character: 'c', out: 'o' };
  assertEquals(bakeSpecFromFlags(base, { ...resolved, mirroring: true }).mirroring, true);
  assertEquals(
    bakeSpecFromFlags([...base, '--no-mirror'], { ...resolved, mirroring: true }).mirroring,
    false,
  );
  assertEquals(bakeSpecFromFlags(base, resolved).mirroring, false);
});

test('--mirror and --no-mirror together are refused, not silently resolved', async () => {
  const c = collector();
  const args = ['bake', '--model', 'm.glb', '--character', 'c', '--out', 'o', '--json'];
  assertEquals(await runCli([...args, '--mirror', '--no-mirror'], c.io), 1);
  const e = JSON.parse(c.out[c.out.length - 1]);
  assertEquals(e.code, 'bad-args');
  assert(e.message.includes('contradict'), e.message);
});

test('bake --mirror reaches the spec, so D-008 is reachable at all', () => {
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

test('flags and a stored look resolve to the SAME camera (D-029)', () => {
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

test('the bake defaults are the standard-30 preset, field for field', () => {
  // The cross-check core/presets_test.ts points at. If either side moves alone,
  // a default bake silently changes framing.
  assertEquals(
    canonicalJson(bakeSpecFromFlags(['bake'], RESOLVED).camera),
    canonicalJson(CAMERA_PRESETS['standard-30']),
  );
  assertEquals(bakeSpecFromFlags(['bake'], RESOLVED).style.id, 'pixel');
});

test('an explicit flag beats the stored look; silence defers to it', () => {
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

test('a default is not a decision: unspoken flags do not overwrite a look', () => {
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

test("a character's own clips drive the bake, disabled ones excepted", () => {
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

test('a bake merges its clips over the stored ones, deleting nothing', () => {
  const stored = [
    { clipId: 'walk-loop', packId: 'ual', enabled: true, frames: 6, speed: 1, holdLast: false },
    { clipId: 'idle-loop', packId: 'ual', enabled: false, frames: 4, speed: 1, holdLast: false },
  ];
  const merged = mergeAnimationSet(
    stored,
    [
      { clipId: 'walk-loop', frames: 8, speed: 1.5, holdLast: true },
      { clipId: 'run-loop', frames: 3, speed: 1, holdLast: false },
    ],
    'ual',
  );
  assertEquals(merged, [
    // re-baked: the new binding wins, and it is enabled because it just ran
    { clipId: 'walk-loop', packId: 'ual', enabled: true, frames: 8, speed: 1.5, holdLast: true },
    // NOT in this bake: `enabled: false` is a choice the bake was never asked
    // about, so a `--clips walk-loop:8,run-loop:3` must not delete it
    { clipId: 'idle-loop', packId: 'ual', enabled: false, frames: 4, speed: 1, holdLast: false },
    // new: appended, so order follows history rather than iteration
    { clipId: 'run-loop', packId: 'ual', enabled: true, frames: 3, speed: 1, holdLast: false },
  ]);

  // a first bake on a character with no bindings yet
  assertEquals(
    mergeAnimationSet(
      undefined,
      [{ clipId: 'walk-loop', frames: 2, speed: 1, holdLast: false }],
      'ual',
    ),
    [{ clipId: 'walk-loop', packId: 'ual', enabled: true, frames: 2, speed: 1, holdLast: false }],
  );
});

test('clips from another pack are refused, not resolved against this one', async () => {
  // The same clip id in a different pack is a different animation. Guessing
  // would render it, write it to the atlas, and report done.
  const ws = await fs.mkdtemp(join(tmpdir(), 'sb-pack-'));
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
      look: { cameraPresetId: 'standard-30', stylePresetId: 'pixel-8' },
      animationSet: [
        {
          clipId: 'walk-loop',
          packId: 'mixamo-personal',
          enabled: true,
          frames: 4,
          speed: 1,
          holdLast: false,
        },
      ],
      mirroring: false,
      lastBakeId: 'aaaaaaaa',
    }, { now });

    const c = collector();
    assertEquals(await runCli(['bake', '--workspace', ws, '--json'], c.io), 1);
    const e = JSON.parse(c.out[c.out.length - 1]);
    assertEquals(e.code, 'pack-mismatch');
    assert(e.message.includes('mixamo-personal'), e.message);
    assert(e.message.includes('--pack'), 'and says how to fix it');
  } finally {
    await fs.rm(ws, { recursive: true });
  }
});

test("a workspace bake keys on the character's real rig and backend", async () => {
  // The two facts a glb cannot state. Under the old sentinels a bake manifest
  // recorded `source-mesh@0` for a character a named backend actually made, so
  // its `inputs` block - the record "re-run exactly this" depends on - named
  // the wrong producer.
  const ws = await fs.mkdtemp(join(tmpdir(), 'sb-prov-'));
  try {
    const { appendGenerationResult, createWorkspace, pickResult, setRigState } = await import(
      '@spritebook/core'
    );
    await createWorkspace({
      workspace: ws,
      characterId: 'brave-knight',
      displayName: 'Brave Knight',
      source: { kind: 'image', originalFilename: 'k.png', sha256: 'a'.repeat(64) },
      now,
    });
    // a bare workspace has neither, and says so
    assertEquals(await provenanceFor(ws), undefined);

    await appendGenerationResult(ws, {
      id: 'r1',
      backend: { modelId: 'trellis2', version: '4b' },
      params: { quality: 'high' },
      seed: 42,
      startedAt: now(),
      wallTimeS: 92.5,
      output: { gltfSha256: 'b'.repeat(64), tris: 14318, kind: 'mesh' },
      discarded: false,
    }, { now });
    await pickResult(ws, 'r1', { heightM: 1.81, texturedBy: 'backend', now });
    const picked = await provenanceFor(ws);
    assertEquals(picked?.backend, {
      modelId: 'trellis2',
      version: '4b',
      params: { quality: 'high' },
    });
    assertEquals(picked?.rig, undefined, 'a picked mesh has no rig yet, and does not pretend to');

    await setRigState(ws, {
      track: 'B',
      skeletonProfile: 'generic',
      jointCount: 52,
      jointEdits: [],
      orientationFixes: [],
      accepted: true,
    }, { now });
    const rigged = await provenanceFor(ws);
    assertEquals(rigged?.rig?.jointCount, 52);
    assertEquals(rigged?.backend?.modelId, 'trellis2', 'and the backend came along');
  } finally {
    await fs.rm(ws, { recursive: true });
  }
});

/** What `bake --workspace` would hand the recipe for this character. */
async function provenanceFor(ws: string) {
  const { readWorkspace } = await import('@spritebook/core');
  return bakeSpecFromFlags(['bake'], {
    model: 'm.glb',
    character: 'c',
    out: 'o',
    provenance: provenanceOf(await readWorkspace(ws)),
  }).provenance;
}

test('a look naming a preset that does not exist says which one, and where from', async () => {
  const ws = await fs.mkdtemp(join(tmpdir(), 'sb-look-'));
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
      mirroring: false,
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
    await fs.rm(ws, { recursive: true });
  }
});

test('an unsupported flag is an error event, never silent success', async () => {
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

test('flag checking does not fire on flags the verbs legitimately take', async () => {
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

test('anim --list finds the bundled pack; --tag filters; --json is one document', async () => {
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

test('gen --adjust refuses seed and prototype keys', async (t) => {
  const workspace = await fs.mkdtemp(join(tmpdir(), 'sb-cli-args-'));
  t.after(() => fs.rm(workspace, { recursive: true }));
  const base = ['gen', '--character', 'hero', '--workspace', workspace, '--image', 'i.png', '--json'];
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

test('rig --accept records the review; undo takes it back', async () => {
  // The missing half of the deform gate: both rig tracks write accepted:false
  // ("theirs to set") and bake warns while it stays false. This is the verb
  // that sets it - ONE journaled patch, so the decision undoes like any other.
  const { createWorkspace, readWorkspace, setRigState, workspacePaths } = await import(
    '@spritebook/core'
  );
  const raw = await fs.mkdtemp(join(tmpdir(), 'sb-accept-'));
  const dir = raw.replaceAll('\\', '/');
  const rig = {
    track: 'B' as const,
    skeletonProfile: 'generic' as const,
    jointCount: 40,
    jointEdits: [],
    orientationFixes: [],
    accepted: false,
  };
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      now: () => '2026-07-12T00:00:00Z',
    });
    return { code, out, err };
  };
  try {
    await createWorkspace({
      workspace: dir,
      characterId: 'knight',
      displayName: 'Knight',
      source: { kind: 'mesh', originalFilename: 'x.glb', sha256: 'a'.repeat(64) },
      now: () => '2026-07-12T00:00:00Z',
    });

    // refusals first: no rig yet, and the contradiction
    const noRig = await run(['rig', '--workspace', dir, '--accept']);
    assertEquals(noRig.code, 1);
    assert(noRig.err.join('\n').includes('no rig to accept'), noRig.err.join('\n'));
    const both = await run(['rig', '--workspace', dir, '--accept', '--unaccept']);
    assertEquals(both.code, 1);
    assert(both.err.join('\n').includes('contradict'), both.err.join('\n'));

    await setRigState(dir, rig, { now: () => '2026-07-12T00:00:00Z' });
    const journalBefore =
      (await fs.readFile(workspacePaths(dir).journal, 'utf8')).trim().split('\n').length;

    const ok = await run(['rig', '--workspace', dir, '--accept', '--json']);
    assertEquals(ok.code, 0, ok.err.join('\n'));
    assertEquals(JSON.parse(ok.out[0]).accepted, true);
    assertEquals((await readWorkspace(dir)).rig!.accepted, true);
    // exactly ONE patch, so exactly one undo owns the decision
    const journalAfter =
      (await fs.readFile(workspacePaths(dir).journal, 'utf8')).trim().split('\n').length;
    assertEquals(journalAfter, journalBefore + 1);

    // idempotence is a refusal, not a silent success
    const again = await run(['rig', '--workspace', dir, '--accept']);
    assertEquals(again.code, 1);
    assert(again.err.join('\n').includes('already accepted'), again.err.join('\n'));

    // undo reverts the ACCEPTANCE, nothing else
    const undo = await run(['undo', '--manifest', `${dir}/character.json`]);
    assertEquals(undo.code, 0, undo.err.join('\n'));
    assertEquals((await readWorkspace(dir)).rig!.accepted, false);

    // and the other direction exists too
    await setRigState(dir, { ...rig, accepted: true }, { now: () => '2026-07-12T00:00:00Z' });
    const un = await run(['rig', '--workspace', dir, '--unaccept']);
    assertEquals(un.code, 0, un.err.join('\n'));
    assertEquals((await readWorkspace(dir)).rig!.accepted, false);
  } finally {
    await fs.rm(raw, { recursive: true });
  }
});

test('rig --auto-hints refuses honestly before any GPU work', async () => {
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      now: () => '2026-07-12T00:00:00Z',
    });
    return { code, out, err: err.join('NEWLINE') };
  };
  const empty = (await fs.mkdtemp(join(tmpdir(), 'sb-ah-'))).replaceAll('\\', '/');
  try {
    // two sources of truth for one joint is a contradiction, not a merge
    const both = await run([
      'rig',
      '--model',
      'x.glb',
      '--out',
      empty,
      '--auto-hints',
      '--rerun-with-hints',
    ]);
    assertEquals(both.code, 1);
    assert(both.err.includes('two sources of truth'), both.err);

    // no previous run in --out: name the three files and the fix
    const bare = await run(['rig', '--model', 'x.glb', '--out', empty, '--auto-hints']);
    assertEquals(bare.code, 1);
    assert(bare.err.includes('deform-report.json'), bare.err);
    assert(bare.err.includes('rig` once first') || bare.err.includes('once first'), bare.err);
  } finally {
    await fs.rm(empty, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Output controls: cell size, world scale, palette size (D-029 look)
// ---------------------------------------------------------------------------

test('--colors sets the palette size, and only the palette size', () => {
  const base = ['bake', '--model', 'm.glb', '--character', 'c', '--out', 'o'];
  const resolved = { model: 'm.glb', character: 'c', out: 'o' };

  // the preset's own count is a DEFAULT, not a ceiling: the pipeline reads
  // quantize.maxColors and the schema allows 2..256, but no flag reached it, so
  // the only way to ask for a different palette was hand-editing look.overrides
  // in character.json - and because resolveStyle merges shallow, that meant
  // restating palette, space and dither too.
  assertEquals(bakeSpecFromFlags(base, resolved).style.quantize?.maxColors, 16);
  const wide = bakeSpecFromFlags([...base, '--colors', '32'], resolved).style;
  assertEquals(wide.quantize?.maxColors, 32);

  // the rest of quantize survives, which is the whole reason the override is
  // built by spreading the effective style rather than naming fields
  const plain = bakeSpecFromFlags(base, resolved).style;
  assertEquals(wide.quantize?.dither, plain.quantize?.dither);
  assertEquals(wide.quantize?.palette, plain.quantize?.palette);
  assertEquals(wide.quantize?.space, plain.quantize?.space);
  assertEquals(wide.outline, plain.outline, 'and nothing outside quantize moves');
  assertEquals(wide.temporal, plain.temporal);
  assertEquals(wide.id, 'pixel', 'the preset it refines is still named');
});

test('--colors refines what the CHARACTER stored, not the bare preset', () => {
  const base = ['bake', '--model', 'm.glb', '--character', 'c', '--out', 'o'];
  // a character that already chose no dithering
  const resolved = {
    model: 'm.glb',
    character: 'c',
    out: 'o',
    look: {
      cameraPresetId: 'standard-30',
      stylePresetId: 'pixel-8',
      overrides: {
        quantize: {
          palette: 'adaptive' as const,
          maxColors: 8,
          space: 'oklab' as const,
          dither: { kind: 'none' as const },
        },
      },
    },
  };
  const s = bakeSpecFromFlags([...base, '--colors', '24'], resolved).style;
  assertEquals(s.quantize?.maxColors, 24);
  assertEquals(
    s.quantize?.dither,
    { kind: 'none' },
    'building the override off the preset would have silently re-enabled dither',
  );
});

test('--colors outside the schema bound names the flag, not a nested path', () => {
  const base = ['bake', '--model', 'm.glb', '--character', 'c', '--out', 'o'];
  const resolved = { model: 'm.glb', character: 'c', out: 'o' };
  for (const n of ['1', '257']) {
    let msg = '';
    try {
      bakeSpecFromFlags([...base, '--colors', n], resolved);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg.includes('--colors'), `names the flag the user typed: ${msg}`);
    assert(msg.includes('2 and 256'), msg);
  }
});

test('--cell takes WxH, because cellPx always had two numbers', () => {
  const base = ['bake', '--model', 'm.glb', '--character', 'c', '--out', 'o'];
  const resolved = { model: 'm.glb', character: 'c', out: 'o' };

  // the preset's own default: D-032 moved it 64 -> 96 for clip-set WIDTH, then
  // D-035 moved it 96 -> 112 because padding 16 (the ground band) eats 32 px of
  // drawable width and the clip set still needs 73
  assertEquals(bakeSpecFromFlags(base, resolved).camera.cellPx, { w: 112, h: 112 });
  assertEquals(
    bakeSpecFromFlags([...base, '--cell', '128'], resolved).camera.cellPx,
    { w: 128, h: 128 },
    'a bare number is still a square',
  );
  assertEquals(
    bakeSpecFromFlags([...base, '--cell', '96x128'], resolved).camera.cellPx,
    { w: 96, h: 128 },
    'a portrait cell was expressible in the manifest and unreachable from the CLI',
  );
  assertEquals(
    bakeSpecFromFlags([...base, '--cell', '96X128'], resolved).camera.cellPx,
    { w: 96, h: 128 },
  );

  // the pivot follows the taller cell, which is the point of asking for one:
  // --cell moves cellPx and leaves paddingPx alone, so the pivot row (h - pad)
  // tracks the new height. D-035 moved the preset's padding 6 -> 16.
  assertEquals(
    bakeSpecFromFlags([...base, '--cell', '96x128'], resolved).camera.paddingPx,
    16,
  );

  for (const bad of ['64xx', 'x64', '64x', 'big', '64x0']) {
    let msg = '';
    try {
      bakeSpecFromFlags([...base, '--cell', bad], resolved);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg.includes('--cell'), `"${bad}" is refused by name: ${msg}`);
  }
});

test('the palette size reaches the CACHE KEY, so two sizes cannot collide', () => {
  // `stylePresetHash` is sha256(canonicalJson(spec.style)) — the whole resolved
  // style, so `quantize.maxColors` is in it by construction. Pinned anyway,
  // because the flag is new and the property it needs is not "the hash exists"
  // but "the flag changes the object being hashed": a --colors 16 bake serving
  // an 8-colour bake's cached frames would ship the wrong sprites and report a
  // cache hit rate that looked like a win.
  const base = ['bake', '--model', 'm.glb', '--character', 'c', '--out', 'o'];
  const resolved = { model: 'm.glb', character: 'c', out: 'o' };
  const at = (n: string) =>
    canonicalJson(bakeSpecFromFlags([...base, '--colors', n], resolved).style);

  assertNotEquals(at('8'), at('16'));
  assertEquals(at('16'), at('16'), 'and the same request is the same key');
  assertEquals(
    at('16'),
    canonicalJson(bakeSpecFromFlags(base, resolved).style),
    "asking for the preset's own count is the preset, so returning to it reuses its frames",
  );

  // the same for the cell, which also grew a shape it did not have
  const cell = (v: string) =>
    canonicalJson(bakeSpecFromFlags([...base, '--cell', v], resolved).camera);
  assertNotEquals(cell('96x128'), cell('96'));
  assertNotEquals(cell('96x128'), cell('128'));
});
