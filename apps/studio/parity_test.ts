/**
 * The CLI-twin parity acceptance (P4-T2).
 *
 * "Every primary action's CLI twin executes identically when pasted in a
 * terminal" is only provable if the test runs the SAME builders the buttons
 * run — so it imports them rather than retyping the arguments. A drift
 * between what a twin displays and what its button does fails here.
 *
 * Ten actions across the whole rail, each run verbatim against a scratch
 * workspace, each asserted on the outcome it claims to produce. The two GPU
 * verbs (bake, export) are gated like every other render test; the other
 * eight run everywhere.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { tryGetGpu } from '../../packages/render/gpu.ts';
import { runCli } from '../../packages/cli/mod.ts';
import {
  acceptRigArgs,
  animDisableArgs,
  animEnableArgs,
  bakeArgs,
  exportArgs,
  genArgs,
  journalArgs,
  modelsArgs,
  moreLikeArgs,
  pickArgs,
} from './src/args.ts';
import { bindingSpec } from './src/bindings.ts';
import { lookArgs } from './src/look.ts';
import { rigRunArgs } from './src/rig.ts';
import { editsFile } from './src/viewport/picking.ts';
import { JointEditsFileSchema, parseWith } from '@spritebook/schema';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const IMAGE = `${REPO}spikes/trellis2/refs/bulma-front.png`;

function io() {
  const out: string[] = [];
  return { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), out };
}

/** Run a twin exactly as the GUI would, and say what it printed if it fails. */
async function twin(args: string[], label: string): Promise<string[]> {
  const o = io();
  const code = await runCli([...args, '--json'], o);
  assertEquals(code, 0, `${label} failed: spritebook ${args.join(' ')}\n${o.out.join('\n')}`);
  return o.out;
}

async function manifestOf(ws: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(`${ws}/character.json`));
}

Deno.test('CLI-twin parity: the GUI actions execute verbatim', async () => {
  const tmp = await Deno.makeTempDir();
  const ws = `${tmp}/parity`;
  try {
    // 1. Generate model — the + tab's primary action, with a candidate ladder
    await twin(
      genArgs(ws, {
        characterId: 'parity',
        imagePath: IMAGE,
        modelId: 'fixture-gen',
        adjust: null,
        candidates: 2,
      }),
      'gen --candidates 2',
    );
    let m = await manifestOf(ws);
    const gen = m.generation as { results: { id: string; seed: number }[] };
    assertEquals(gen.results.length, 2, 'two candidates recorded');
    assertEquals(gen.results.map((r) => r.seed), [0, 1000], 'the stride convention holds');

    // 2. More like this — the candidate card's re-roll. It reproduces the
    // parent's RECIPE with a new seed, and that recipe recorded candidates:2,
    // so one click legitimately yields two more results. The parity run is
    // where that surfaced; the card now says so on the button.
    await twin(moreLikeArgs(ws, 'parity', 'r1'), 'gen --more-like');
    m = await manifestOf(ws);
    const after = (m.generation as { results: { id: string; params: { candidates?: number } }[] })
      .results;
    assertEquals(after.length, 4, 'the parent recipe re-ran its two-candidate ladder');
    assertEquals(after[0]!.params.candidates, 2, 'and the ladder is IN the recorded params');

    // 3. Save as canonical mesh — pick with the shipped defaults ON
    await twin(pickArgs(ws, 'r1', { reproject: true, colorMatch: true }), 'pick');
    m = await manifestOf(ws);
    assertEquals((m.generation as { pickedResultId: string }).pickedResultId, 'r1');
    assert(m.canonicalMesh !== undefined, 'the checkpoint the stage rail unlocks on');

    // 4. Record look — the Look stage's Apply, at a diverging elevation
    await twin(
      lookArgs(ws, {
        cameraPresetId: 'standard-30',
        stylePresetId: 'pixel',
        elevationDeg: 26.565,
        directions: 8,
        pixelsPerMeter: 32,
        cellW: 64,
        cellH: 64,
        maxColors: 16,
        outlineWidthPx: 0.5,
      }, {
        id: 'standard-30',
        elevationDeg: 30,
        directions: 8,
        yawOffsetDeg: 0,
        pixelsPerMeter: 32,
        cellPx: { w: 64, h: 64 },
        paddingPx: 6,
      }, { id: 'pixel', mode: 'pixel', maxColors: 16, outlineWidthPx: 0.5 }),
      'look (elevation diverged)',
    );
    m = await manifestOf(ws);
    const look = m.look as { cameraOverrides?: { elevationDeg?: number }; stylePresetId: string };
    assertEquals(look.cameraOverrides?.elevationDeg, 26.565, 'only the divergence travelled');
    assertEquals(look.stylePresetId, 'pixel');

    // 5. Enable clips — the Anim library's per-clip action, twice over
    await twin(
      animEnableArgs(ws, [
        bindingSpec({ clipId: 'idle-loop', frames: 6, speed: 1, holdLast: false }),
        bindingSpec({ clipId: 'walk-loop', frames: 8, speed: 1.5, holdLast: false }),
      ]),
      'anim --enable',
    );
    m = await manifestOf(ws);
    let set = m.animationSet as { clipId: string; enabled: boolean; frames: number }[];
    assertEquals(set.map((b) => [b.clipId, b.frames, b.enabled]), [
      ['idle-loop', 6, true],
      ['walk-loop', 8, true],
    ]);

    // 6. Disable — the binding row's opt-out, numbers preserved
    await twin(animDisableArgs(ws, ['walk-loop']), 'anim --disable');
    m = await manifestOf(ws);
    set = m.animationSet as typeof set;
    assertEquals(set[1]!.enabled, false);
    assertEquals(set[1]!.frames, 8, 'a disabled binding keeps what it said');

    // 7. Undo — the Edit menu / Ctrl+Z, over the same journal
    await twin(journalArgs(ws, 'undo'), 'undo');
    m = await manifestOf(ws);
    assertEquals(
      (m.animationSet as { enabled: boolean }[])[1]!.enabled,
      true,
      'the disable came back',
    );

    // 8. Redo — and it goes away again
    await twin(journalArgs(ws, 'redo'), 'redo');
    m = await manifestOf(ws);
    assertEquals((m.animationSet as { enabled: boolean }[])[1]!.enabled, false);

    // 9. Manage models → list, the dialog's read
    const listed = await twin(modelsArgs('list'), 'models list');
    const catalog = JSON.parse(listed.at(-1)!);
    assert(
      (catalog.models as { id: string }[]).some((x) => x.id === 'fixture-gen'),
      'the backend the Generate cards offered is the one the catalog has',
    );

    // 10. Apply joint edits — the viewport's gizmo nudges become this file,
    // and core's OWN schema is what judges it. A GUI that wrote a document
    // the verb refuses would fail here rather than in front of a user.
    //
    // The full `rig --edits` run is deliberately NOT in the suite: it is a
    // real UniRig pass (~70s, GPU + installed weights). It was executed once
    // by hand against this exact builder and exited 0, applying the edits;
    // what belongs in every run is the contract the GUI is responsible for —
    // that the document it writes is one core will accept.
    const doc = editsFile([
      { joint: 'clavicle_r', delta: [0.012, -0.004, 0], mirrored: true },
      { joint: 'thumb_03_l', delta: [0, 0.003, 0.001], mirrored: false },
    ]);
    parseWith(JointEditsFileSchema, doc, 'JointEditsFile from the viewport');
    assertEquals(rigRunArgs(ws, { editsPath: 'p.json' }).slice(-2), ['--edits', 'p.json']);

    // 11. Accept rig — refused HONESTLY here, which is itself the contract:
    // this character has no rig, and the twin says so rather than pretending
    const o = io();
    const code = await runCli([...acceptRigArgs(ws, false), '--json'], o);
    assertEquals(code, 1);
    assert(o.out.join('\n').includes('no rig'), `named the reason: ${o.out.join('\n')}`);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test('CLI-twin parity: bake and export (GPU)', async () => {
  if (!(await tryGetGpu())) {
    console.log('skip: no GPU adapter — the render twins need one');
    return;
  }
  const tmp = await Deno.makeTempDir();
  const ws = `${tmp}/parity-gpu`;
  try {
    await twin(
      genArgs(ws, {
        characterId: 'paritygpu',
        imagePath: IMAGE,
        modelId: 'fixture-gen',
        adjust: null,
      }),
      'gen',
    );
    await twin(pickArgs(ws, 'r1', { reproject: true, colorMatch: true }), 'pick');

    // 12. Bake sheet — the Bake stage's primary action
    await twin(bakeArgs(ws), 'bake');
    const m = await manifestOf(ws);
    const bakeId = m.lastBakeId as string;
    assert(typeof bakeId === 'string', 'the bake recorded itself on the manifest');
    const bakeManifest = JSON.parse(
      await Deno.readTextFile(`${ws}/bakes/bake-${bakeId}/manifest.json`),
    );
    assert(bakeManifest.frames.length > 0, 'frames landed');

    // 13. Export selected — over that bake, in the shape the stage builds
    const out = `${ws}/export`;
    await twin(exportArgs(`${ws}/bakes/bake-${bakeId}`, out, ['godot', 'strips']), 'export');
    // each target produced its folder, which is what the done state lists
    for (const target of ['godot', 'strips']) {
      const stat = await Deno.stat(`${out}/${target}`);
      assert(stat.isDirectory, `${target} produced a folder`);
    }
    const godot = [...Deno.readDirSync(`${out}/godot`)].map((e) => e.name);
    assert(godot.some((n) => n.endsWith('.tres')), `the Godot resource exists: ${godot}`);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
