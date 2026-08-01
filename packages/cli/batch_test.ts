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
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { createWorkspace, workspacePaths } from '@spritebook/core';
import {
  BakePlanSchema,
  canonicalJson,
  type CharacterId,
  PLAN_FILE,
  ROSTER_FILE,
} from '@spritebook/schema';
import { passthroughBakeArgs, runCli } from './mod.ts';

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
  const doc = JSON.parse(await Deno.readTextFile(p.manifest));
  if (opts.mesh !== false) {
    await Deno.mkdir(p.canonicalDir, { recursive: true });
    await Deno.writeTextFile(p.canonicalModel, `mesh bytes for ${id}`);
    doc.canonicalMesh = {
      gltfSha256: 'b'.repeat(64),
      heightM: 1.8,
      texturedBy: 'backend',
      reprojected: false,
    };
  }
  if (opts.look) doc.look = opts.look;
  await Deno.writeTextFile(p.manifest, canonicalJson(doc));
  return dir;
}

async function roster3(): Promise<string> {
  const root = await Deno.makeTempDir();
  await member(root, 'bulma');
  await member(root, 'goku');
  await member(root, 'trunks', { mesh: false });
  return root;
}

Deno.test('--all without --root says which flag is missing', async () => {
  const o = io();
  assertEquals(await runCli(['bake', '--all'], o), 1);
  assert(o.all().includes('--root'), o.all());
});

Deno.test('--all and --workspace contradict each other, and are refused', async () => {
  const o = io();
  assertEquals(await runCli(['bake', '--all', '--root', '.', '--workspace', 'x'], o), 1);
  assert(o.all().includes('one or the other'), o.all());
});

Deno.test('--changed-since needs a real date', async () => {
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

Deno.test('the plan names every character and why, and renders nothing', async () => {
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
      assertEquals(await Deno.stat(bakes).catch(() => null), null, `${id} baked nothing`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('--plan --json is ONE plan document, not an event stream', async () => {
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
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('the roster index and the plan both land on disk', async () => {
  const root = await roster3();
  try {
    await runCli(['bake', '--all', '--root', root, '--plan', '--json'], io());
    // the plan is a receipt of what the batch decided, written on every run
    const plan = BakePlanSchema.parse(
      JSON.parse(await Deno.readTextFile(`${root}/${PLAN_FILE}`)),
    );
    assertEquals(plan.characters.length, 3);
    const roster = JSON.parse(await Deno.readTextFile(`${root}/${ROSTER_FILE}`));
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
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('--changed-since narrows the plan to what was touched', async () => {
  const root = await roster3();
  try {
    const past = new Date(Date.now() - 3600_000);
    for (const id of ['bulma', 'trunks']) {
      await Deno.utime(workspacePaths(`${root}/${id}`).manifest, past, past);
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
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('ONE broken character does not take the roster down with it', async () => {
  const root = await roster3();
  try {
    // a look naming a style that does not exist — the single-character bake
    // refuses this outright, and at roster scale that refusal must be local
    await member(root, 'vegeta', {
      look: { cameraPresetId: 'standard-30', stylePresetId: 'no-such-style' },
    });
    await Deno.writeTextFile(`${root}/wrecked/character.json`, '{ not json').catch(async () => {
      await Deno.mkdir(`${root}/wrecked`, { recursive: true });
      await Deno.writeTextFile(`${root}/wrecked/character.json`, '{ not json');
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
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('an empty root plans nothing and succeeds', async () => {
  const root = await Deno.makeTempDir();
  try {
    const o = io();
    assertEquals(await runCli(['bake', '--all', '--root', root, '--plan'], o), 0);
    assert(o.all().includes('0 to bake · 0 fresh · 0 blocked'), o.all());
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('a root that is not there fails by name, not by stack trace', async () => {
  const o = io();
  assertEquals(await runCli(['bake', '--all', '--root', `${await Deno.makeTempDir()}/nope`], o), 1);
  assert(o.all().includes('Cannot read the roster root'), o.all());
});

Deno.test('each character bakes with EXACTLY the flags the batch was given', () => {
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
