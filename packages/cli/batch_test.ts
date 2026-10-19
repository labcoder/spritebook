import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * `bake --all` and the plan it prints first.
 *
 * None of these need a GPU, which is the point: the plan's whole value is that
 * it answers "what would this cost, and why" without rendering. Every test
 * here is therefore a test of the ANSWER, not of the bake — the bake itself is
 * proven by the 10-character roster run in tools/proofs/roster10.ts.
 *
 * The recurring assertion is the one this task exists for: a roster where one
 * character is broken must still plan and bake the others, and must name the
 * broken one. Silence over a partial batch is the failure mode.
 */
import { assert, assertEquals } from '@std/assert';
import { createWorkspace, workspacePaths } from '@spritebook/core';
import {
  BakePlanSchema,
  canonicalJson,
  type CharacterId,
  PLAN_FILE,
  ROSTER_FILE,
} from '@spritebook/schema';
import { passthroughBakeArgs, runCli } from './dist/mod.js';
import { formatWarnings, summariseWarnings, warnTee } from './dist/batch.js';

const NOW = () => '2026-08-01T00:00:00Z';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    now: NOW,
    out,
    err,
    all: () => [...out, ...err].join('\n'),
  };
}

/** A workspace under `root`; `mesh: false` leaves it unbakeable on purpose. */
async function member(
  root: string,
  id: string,
  opts: { mesh?: boolean; look?: Record<string, unknown> } = {},
): Promise<string> {
  const dir = `${root}/${id}`;
  await createWorkspace({
    workspace: dir,
    characterId: id as CharacterId,
    displayName: id[0]!.toUpperCase() + id.slice(1),
    source: { kind: 'mesh', originalFilename: `${id}.glb`, sha256: 'a'.repeat(64) },
    now: NOW,
  });
  const p = workspacePaths(dir);
  const doc = JSON.parse(await fs.readFile(p.manifest, 'utf8'));
  if (opts.mesh !== false) {
    await fs.mkdir(p.canonicalDir, { recursive: true });
    await fs.writeFile(p.canonicalModel, `mesh bytes for ${id}`);
    doc.canonicalMesh = {
      gltfSha256: 'b'.repeat(64),
      heightM: 1.8,
      texturedBy: 'backend',
      reprojected: false,
    };
  }
  if (opts.look) doc.look = opts.look;
  await fs.writeFile(p.manifest, canonicalJson(doc));
  return dir;
}

async function roster3(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  await member(root, 'bulma');
  await member(root, 'goku');
  await member(root, 'trunks', { mesh: false });
  return root;
}

test('--all without --root says which flag is missing', async () => {
  const o = io();
  assertEquals(await runCli(['bake', '--all'], o), 1);
  assert(o.all().includes('--root'), o.all());
});

test('--all and --workspace contradict each other, and are refused', async () => {
  const o = io();
  assertEquals(await runCli(['bake', '--all', '--root', '.', '--workspace', 'x'], o), 1);
  assert(o.all().includes('one or the other'), o.all());
});

test('--changed-since needs a real date', async () => {
  const o1 = io();
  assertEquals(await runCli(['bake', '--all', '--root', '.', '--changed-since'], o1), 1);
  assert(o1.all().includes('ISO timestamp'), o1.all());
  const o2 = io();
  assertEquals(
    await runCli(['bake', '--all', '--root', '.', '--changed-since', 'yesterday'], o2),
    1,
  );
  assert(o2.all().includes('is not a date'), o2.all());
});

test('the plan names every character and why, and renders nothing', async () => {
  const root = await roster3();
  try {
    const o = io();
    const code = await runCli(['bake', '--all', '--root', root, '--plan'], o);
    const text = o.all();
    assertEquals(code, 1, 'a blocked character makes the run non-zero');
    assert(text.includes('Bulma (bulma) — never baked'), text);
    assert(text.includes('Trunks (trunks) — BLOCKED'), text);
    assert(text.includes('no canonical mesh on disk'), 'the block says what to do about it');
    assert(text.includes('2 to bake · 0 fresh · 1 blocked'), text);
    // nothing rendered: no bake directory anywhere
    for (const id of ['bulma', 'goku']) {
      const bakes = workspacePaths(`${root}/${id}`).bakesDir;
      assertEquals(await fs.stat(bakes).catch(() => null), null, `${id} baked nothing`);
    }
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('--plan --json is ONE plan document, not an event stream', async () => {
  const root = await roster3();
  try {
    const o = io();
    await runCli(['bake', '--all', '--root', root, '--plan', '--json'], o);
    assertEquals(o.out.length, 1, 'a query snapshot writes a document');
    const plan = BakePlanSchema.parse(JSON.parse(o.out[0]!));
    assertEquals(plan.totals.considered, 3);
    assertEquals(plan.totals.toBake, 2);
    assertEquals(plan.totals.blocked, 1);
    assertEquals(plan.characters.map((c) => c.id), ['bulma', 'goku', 'trunks']);
    // 8 directions × 6 frames, the shipped defaults, twice
    assertEquals(plan.totals.staleFrames, 96);
    assertEquals(plan.totals.cachedFrames, 0);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('the roster index and the plan both land on disk', async () => {
  const root = await roster3();
  try {
    await runCli(['bake', '--all', '--root', root, '--plan', '--json'], io());
    // the plan is a receipt of what the batch decided, written on every run
    const plan = BakePlanSchema.parse(
      JSON.parse(await fs.readFile(`${root}/${PLAN_FILE}`, 'utf8')),
    );
    assertEquals(plan.characters.length, 3);
    const roster = JSON.parse(await fs.readFile(`${root}/${ROSTER_FILE}`, 'utf8'));
    // the SCAN's census is everyone whose manifest parsed, mesh or not; deciding
    // that a mesh-less character cannot bake is the PLAN's judgement, not the
    // index's, and keeping them separate is what lets the plan say why
    assertEquals(roster.characters.length, 3);
    assertEquals(
      roster.characters.filter((c: { ready: boolean }) => c.ready).length,
      2,
      'and readiness is recorded rather than acted on',
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('--changed-since narrows the plan to what was touched', async () => {
  const root = await roster3();
  try {
    const past = new Date(Date.now() - 3600_000);
    for (const id of ['bulma', 'trunks']) {
      await fs.utimes(workspacePaths(`${root}/${id}`).manifest, past, past);
    }
    const cutoff = new Date(Date.now() - 1800_000).toISOString();
    const o = io();
    await runCli(
      ['bake', '--all', '--root', root, '--plan', '--changed-since', cutoff, '--json'],
      o,
    );
    const plan = BakePlanSchema.parse(JSON.parse(o.out[0]!));
    assertEquals(plan.characters.map((c) => c.id), ['goku']);
    assertEquals(plan.changedSince, cutoff, 'the plan records the filter it was taken under');
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('ONE broken character does not take the roster down with it', async () => {
  const root = await roster3();
  try {
    // a look naming a style that does not exist — the single-character bake
    // refuses this outright, and at roster scale that refusal must be local
    await member(root, 'vegeta', {
      look: { cameraPresetId: 'standard-30', stylePresetId: 'no-such-style' },
    });
    await fs.writeFile(`${root}/wrecked/character.json`, '{ not json').catch(async () => {
      await fs.mkdir(`${root}/wrecked`, { recursive: true });
      await fs.writeFile(`${root}/wrecked/character.json`, '{ not json');
    });

    const o = io();
    await runCli(['bake', '--all', '--root', root, '--plan', '--json'], o);
    const plan = BakePlanSchema.parse(JSON.parse(o.out[0]!));
    const by = Object.fromEntries(plan.characters.map((c) => [c.id, c]));
    assertEquals(by.bulma!.state, 'never-baked', 'the healthy ones still plan');
    assertEquals(by.goku!.state, 'never-baked');
    assertEquals(by.vegeta!.state, 'blocked');
    assert(by.vegeta!.note!.includes('no-such-style'), by.vegeta!.note);
    assertEquals(by.wrecked!.state, 'blocked');
    assert(by.wrecked!.note!.includes('unreadable'), by.wrecked!.note);
    assertEquals(plan.totals.blocked, 3, 'blocked characters are counted, never dropped');
    assertEquals(plan.totals.toBake, 2);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('an empty root plans nothing and succeeds', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const o = io();
    assertEquals(await runCli(['bake', '--all', '--root', root, '--plan'], o), 0);
    assert(o.all().includes('0 to bake · 0 fresh · 0 blocked'), o.all());
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('a root that is not there fails by name, not by stack trace', async () => {
  const o = io();
  assertEquals(
    await runCli([
      'bake',
      '--all',
      '--root',
      `${await fs.mkdtemp(join(tmpdir(), 'spritebook-'))}/nope`,
    ], o),
    1,
  );
  assert(o.all().includes('Cannot read the roster root'), o.all());
});

test('each character bakes with EXACTLY the flags the batch was given', () => {
  // the plan predicted a recipe; the bake has to run that recipe, so the
  // batch's own flags are stripped and everything else passes through verbatim
  assertEquals(
    passthroughBakeArgs([
      'bake',
      '--all',
      '--root',
      '/r',
      '--changed-since',
      '2026-08-01T00:00:00Z',
      '--plan',
      '--style',
      'pixel',
      '--colors',
      '24',
      '--only-invalidated',
      '--json',
    ]),
    ['--style', 'pixel', '--colors', '24', '--only-invalidated', '--json'],
  );
  // --workspace is the batch's to set, per character
  assertEquals(passthroughBakeArgs(['bake', '--workspace', '/w', '--frames', '4']), [
    '--frames',
    '4',
  ]);
  // a valueless batch flag at end-of-line must not eat the next real flag
  assertEquals(passthroughBakeArgs(['bake', '--root', '--frames', '4']), ['--frames', '4']);
});

test('the batch KEEPS its children’s warnings, in both output modes', () => {
  // a batch runs each character through runCli, so a warn goes to the terminal
  // and nowhere a summary can reach it. Both forms are recognised because the
  // batch does not control which one it is in.
  const sink = { stdout: () => {}, stderr: () => {} };
  const json = warnTee(sink);
  json.io.stdout(JSON.stringify({
    t: 'warn',
    jobId: 'bake',
    at: NOW(),
    code: 'rig-unaccepted',
    message: 'the rig was never accepted',
  }));
  json.io.stdout(JSON.stringify({ t: 'done', jobId: 'bake', at: NOW(), wallTimeS: 1 }));
  assertEquals(json.warns, [{ code: 'rig-unaccepted', message: 'the rig was never accepted' }]);

  const human = warnTee(sink);
  human.io.stdout('warn [style-alias]: "clean" is retired; using "cel-2"');
  human.io.stdout('done in 2.3s');
  assertEquals(human.warns, [{
    code: 'style-alias',
    message: '"clean" is retired; using "cel-2"',
  }]);

  // a message spanning lines is kept whole, and a line that merely mentions
  // the word is not mistaken for one
  const tricky = warnTee(sink);
  tricky.io.stdout('warn [multi]: first line\nsecond line');
  tricky.io.stdout('the word warn appears here but this is not an event');
  tricky.io.stdout('{ not json after all');
  assertEquals(tricky.warns.length, 1);
  assertEquals(tricky.warns[0]!.message, 'first line\nsecond line');
});

test('everything passes through the tee untouched', () => {
  // it is a tee, not a filter: the terminal must see exactly what it saw before
  const out: string[] = [];
  const err: string[] = [];
  const t = warnTee({ stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  t.io.stdout('warn [x]: y');
  t.io.stdout('plain');
  t.io.stderr('error: bad');
  assertEquals(out, ['warn [x]: y', 'plain']);
  assertEquals(err, ['error: bad']);
});

test('warnings summarise by CODE, counting characters not occurrences', () => {
  // "rig-unaccepted on 100 characters" is the sentence a morning reader needs;
  // a character that warned twice must not read as two characters
  const summary = summariseWarnings([
    { characterId: 'a', code: 'rig-unaccepted', message: 'the rig for a' },
    { characterId: 'a', code: 'rig-unaccepted', message: 'the rig for a again' },
    { characterId: 'b', code: 'rig-unaccepted', message: 'the rig for b' },
    { characterId: 'b', code: 'style-alias', message: 'clean is retired' },
  ]);
  assertEquals(summary.map((w) => [w.code, w.characters]), [
    ['rig-unaccepted', 2],
    ['style-alias', 1],
  ], 'most-affected first');
  assertEquals(summary[0]!.example, 'the rig for a', 'one verbatim message, not a count');
  assertEquals(summary[0]!.firstCharacters, ['a', 'b']);
  assertEquals(summariseWarnings([]), []);
});

test('the summary a human reads names the code, the count AND the remedy', () => {
  const lines = formatWarnings(
    summariseWarnings([{
      characterId: 'a',
      code: 'rig-unaccepted',
      message: 'record it with `spritebook rig --accept`, which since D-031 costs nothing',
    }]),
    100,
  );
  const text = lines.join('\n');
  assert(text.includes('rig-unaccepted — 1/100'), text);
  assert(text.includes('costs nothing'), 'the remedy survives into the summary');
  assertEquals(formatWarnings([], 0), ['no warnings across the batch']);
});
