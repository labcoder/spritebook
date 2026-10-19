/**
 * The manifest-driven-bake acceptances, on real bakes (GPU-gated;
 * SPRITEBOOK_REQUIRE_GPU forces them on the lavapipe lane).
 *
 * **Mirroring.** `--mirror` once records the choice on the character; a bake
 * with NO flags at all still mirrors; `--no-mirror` turns it off for one bake
 * and moves the bakeId, because mirroring changes the pixels. Four directions
 * is the cheapest count that mirrors at all — at two, nothing does, and the
 * test would pass while asserting nothing.
 *
 * **Look and clips (D-029):**
 *
 *   1. a flag-driven `bake --workspace` records the look it ran with and the
 *      bake it produced;
 *   2. a second bake with NO camera, style or clip flags reproduces the FIRST
 *      one — same bakeId, same manifest modulo the documented volatile fields —
 *      which is the whole claim of the feature: the character now carries its
 *      own settings, and the flags were only ever one way to state them;
 *   3. changing `look.overrides` alone moves the bakeId, so the stored look is
 *      really an input to the cache key and not decoration;
 *   4. `--frames` is the one bake input that does NOT round-trip, and step 4
 *      pins that on purpose — see the comment there.
 *
 * The rebake in step 2 must also find every frame in the cache, and that is the
 * sharper half: a bakeId could in principle collide, but 100% hits mean the
 * recipe hashed identically all the way down to each frame.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { BakeManifestSchema, canonicalJson, parseWith } from '@spritebook/schema';
import type { BakeManifest } from '@spritebook/schema';
import {
  createWorkspace,
  readWorkspace,
  recordBake,
  setRigState,
  sha256Bytes,
  sha256Hex,
  workspacePaths,
} from '@spritebook/core';
import { tryGetGpu } from '../render/gpu.ts';
import { runCli } from './mod.ts';
import { rigForKey } from '@spritebook/pack';
import { NodeIO } from '@gltf-transform/core';
import { appendGenerationResult, resultPaths } from '@spritebook/core';

const GLB = new URL('../style/fixtures/asymmetric.glb', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const NOW = () => '2026-07-12T00:00:00Z';

Deno.test('pick A -> pick B -> undo bakes the restored mesh, not just its metadata', async () => {
  if (!(await tryGetGpu())) return;
  const dir = await Deno.makeTempDir({ prefix: 'sb-asset-undo-' });
  try {
    await createWorkspace({
      workspace: dir,
      characterId: 'asset-undo',
      displayName: 'Asset undo',
      source: {
        kind: 'mesh',
        originalFilename: 'asymmetric.glb',
        sha256: await sha256Bytes(await Deno.readFile(GLB)),
      },
    });
    const io = new NodeIO();
    const doc = await io.readBinary(await Deno.readFile(GLB));
    doc.getRoot().listMeshes()[0].listPrimitives()[0].setMaterial(
      doc.createMaterial().setBaseColorFactor([1, 0, 0, 1]),
    );
    const variants = [await Deno.readFile(GLB), await io.writeBinary(doc)];
    for (const [i, bytes] of variants.entries()) {
      const id = `r${i + 1}`;
      const paths = resultPaths(dir, id);
      await Deno.mkdir(paths.dir, { recursive: true });
      await Deno.writeFile(paths.model, bytes);
      await appendGenerationResult(dir, {
        id,
        backend: { modelId: 'fixture-gen', version: '1.0.0' },
        params: {},
        seed: i,
        startedAt: NOW(),
        wallTimeS: 0,
        output: { gltfSha256: await sha256Bytes(bytes), tris: 1, kind: 'mesh' },
        discarded: false,
      });
    }
    const run = async (args: string[]) => {
      const c = collector();
      assertEquals(await runCli([...args, '--json'], c.io), 0, [...c.out, ...c.err].join('\n'));
    };
    const pick = (id: string) =>
      run(['pick', '--workspace', dir, '--result', id, '--no-color-match', '--no-reproject']);
    const bake = () =>
      run([
        'bake',
        '--workspace',
        dir,
        '--style',
        'clean',
        '--directions',
        '2',
        '--cell',
        '64',
        '--frames',
        '2',
      ]);
    await pick('r1');
    await bake();
    const before = (await readWorkspace(dir)).lastBakeId!;
    const page = `${workspacePaths(dir).bakesDir}/bake-${before}/atlas_lit_0.png`;
    const expected = await Deno.readFile(page);
    await pick('r2');
    assertEquals(await Deno.readFile(workspacePaths(dir).canonicalModel), variants[1]);
    await run(['undo', '--manifest', workspacePaths(dir).manifest]);
    await bake();
    assertEquals(
      (await readWorkspace(dir)).lastBakeId,
      before,
      'bake keys the actual restored input',
    );
    assertEquals(await Deno.readFile(page), expected, 'the rerendered pixels agree too');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function collector() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (l: string) => out.push(l),
      stderr: (l: string) => err.push(l),
      now: NOW,
    },
  };
}

/** The bake manifest of one bake in the workspace's bakes dir. */
async function bakeManifest(dir: string, bakeId: string): Promise<BakeManifest> {
  const path = `${workspacePaths(dir).bakesDir}/bake-${bakeId}/manifest.json`;
  return parseWith(BakeManifestSchema, JSON.parse(await Deno.readTextFile(path)), path);
}

/**
 * A bake manifest with the three fields pack/contracts.ts documents as volatile
 * removed, plus the per-frame cacheHit flag — a cache HIT is exactly what the
 * second bake is supposed to be, so it cannot also be part of what must match.
 */
function recipe(m: BakeManifest): string {
  return canonicalJson({
    ...m,
    createdAt: '',
    frames: m.frames.map((f) => ({ ...f, cacheHit: false })),
    metrics: { ...m.metrics, wallTimeS: 0, cacheHitPct: 0 },
  });
}

/** A workspace whose canonical model is the asymmetric fixture. */
async function character(dir: string): Promise<void> {
  await createWorkspace({
    workspace: dir,
    characterId: 'brave-knight',
    displayName: 'Brave Knight',
    source: { kind: 'mesh', originalFilename: 'asymmetric.glb', sha256: 'a'.repeat(64) },
    now: NOW,
  });
  await Deno.copyFile(GLB, workspacePaths(dir).canonicalModel);
}

/** Which directions this bake produced by flipping, and from where. */
function flips(m: BakeManifest): Array<[number, number]> {
  const out = new Map<number, number>();
  for (const f of m.frames) {
    if (f.mirroredFrom) out.set(f.direction, f.mirroredFrom.direction);
  }
  return [...out].sort((a, b) => a[0] - b[0]);
}

Deno.test('acceptance: --mirror once, then mirrored from the workspace alone', async (t) => {
  if (!(await tryGetGpu())) return;
  const raw = await Deno.makeTempDir({ prefix: 'sb-mirror-ws-' });
  const dir = raw.replaceAll('\\', '/');
  const cache = `${dir}/cache`;
  // 4 directions is the cheapest count that mirrors at all: direction 3 is the
  // flip of direction 1, and 0 and 2 face along the mirror plane so they have
  // no partner. At 2 nothing mirrors and the test would pass vacuously.
  const geometry = ['--directions', '4', '--cell', '48', '--style', 'cel-2'];
  try {
    await character(dir);

    let mirroredId = '';
    await t.step('--mirror records the choice on the character', async () => {
      const c = collector();
      assertEquals(
        await runCli(
          [
            'bake',
            '--workspace',
            dir,
            ...geometry,
            '--mirror',
            '--cache',
            cache,
            '--only-invalidated',
            '--json',
          ],
          c.io,
        ),
        0,
        c.err.join('\n'),
      );
      const manifest = await readWorkspace(dir);
      assertEquals(manifest.mirroring, { enabled: true }, 'the bake wrote its own D-008 choice');
      mirroredId = manifest.lastBakeId!;
      assertEquals(flips(await bakeManifest(dir, mirroredId)), [[3, 1]], 'direction 3 is a flip');
    });

    await t.step('THE acceptance: no flags at all, and it still mirrors', async () => {
      const c = collector();
      assertEquals(
        await runCli(
          ['bake', '--workspace', dir, '--cache', cache, '--only-invalidated', '--json'],
          c.io,
        ),
        0,
        c.err.join('\n'),
      );
      const manifest = await readWorkspace(dir);
      assertEquals(manifest.lastBakeId, mirroredId, 'same recipe, same bakeId');
      const baked = await bakeManifest(dir, mirroredId);
      assertEquals(flips(baked), [[3, 1]], 'and the same direction is still a flip');
      assertEquals(baked.frames.every((f) => f.cacheHit), true, 'served entirely from cache');
    });

    await t.step('--no-mirror is how a yes says no for one bake', async () => {
      const c = collector();
      assertEquals(
        await runCli(
          [
            'bake',
            '--workspace',
            dir,
            '--no-mirror',
            '--cache',
            cache,
            '--only-invalidated',
            '--json',
          ],
          c.io,
        ),
        0,
        c.err.join('\n'),
      );
      const manifest = await readWorkspace(dir);
      assertEquals(manifest.mirroring, { enabled: false }, 'and the override is recorded too');
      assert(
        manifest.lastBakeId !== mirroredId,
        'mirroring changes the PIXELS, so it moves the key',
      );
      const baked = await bakeManifest(dir, manifest.lastBakeId!);
      assertEquals(flips(baked), [], 'every direction rendered for real');
      assertEquals(baked.frames.length, 4 * 6, '4 directions x the default 6 frames');
    });
  } finally {
    await Deno.remove(raw, { recursive: true });
  }
});

Deno.test('acceptance: a workspace bake reproduces the last one exactly', async (t) => {
  if (!(await tryGetGpu())) return;
  const raw = await Deno.makeTempDir({ prefix: 'sb-bake-ws-' });
  const dir = raw.replaceAll('\\', '/');
  const cache = `${dir}/cache`;
  try {
    await character(dir);

    let firstId = '';
    let firstRecipe = '';
    await t.step('a flag-driven bake records what it ran with', async () => {
      const c = collector();
      const code = await runCli([
        'bake',
        '--workspace',
        dir,
        '--style',
        'cel-2',
        '--camera',
        'isometric',
        '--directions',
        '2',
        '--cell',
        '48',
        '--elevation',
        '22',
        '--cache',
        cache,
        '--only-invalidated',
        '--json',
      ], c.io);
      assertEquals(code, 0, c.err.join('\n'));

      const manifest = await readWorkspace(dir);
      assert(manifest.lastBakeId !== undefined, 'lastBakeId names the bake it produced');
      firstId = manifest.lastBakeId;
      assertEquals(manifest.look, {
        cameraPresetId: 'isometric',
        // ONLY what differs from the preset: px/m, padding and yaw were never
        // mentioned, so they stay the preset's rather than being restated as
        // overrides claiming a change nobody made
        cameraOverrides: { cellPx: { w: 48, h: 48 }, directions: 2, elevationDeg: 22 },
        stylePresetId: 'cel-2',
      });
      // no --clips and no stored bindings: an idle-stub bake settles nothing
      // about this character's clips, so the field stays absent, not []
      assertEquals(manifest.animationSet, undefined);

      const baked = await bakeManifest(dir, firstId);
      assertEquals(baked.bakeId, firstId, 'and that bake is really on disk');
      assertEquals(baked.characterId, 'brave-knight', 'the workspace supplied the id');
      firstRecipe = recipe(baked);
    });

    await t.step('the same bake with NO camera or style flags reproduces it', async () => {
      const c = collector();
      const code = await runCli(
        ['bake', '--workspace', dir, '--cache', cache, '--only-invalidated', '--json'],
        c.io,
      );
      assertEquals(code, 0, c.err.join('\n'));

      const manifest = await readWorkspace(dir);
      assertEquals(manifest.lastBakeId, firstId, 'THE acceptance: same recipe, same bakeId');

      const baked = await bakeManifest(dir, firstId);
      assertEquals(recipe(baked), firstRecipe, 'byte-identical but for the volatile fields');
      assertEquals(baked.frames.every((f) => f.cacheHit), true, 'every frame came from cache');
      assertEquals(baked.metrics.cacheHitPct, 100);
    });

    await t.step('changing look.overrides alone moves the bakeId', async () => {
      const before = await readWorkspace(dir);
      // cel-2 ships 1-bit alpha; this is the manifest asking for soft, and
      // nothing else about the bake changes
      await recordBake(dir, {
        look: { ...before.look!, overrides: { alpha: { mode: 'soft', bleedPx: 4 } } },
        mirroring: false,
        lastBakeId: before.lastBakeId!,
      }, { now: NOW });

      const c = collector();
      assertEquals(
        await runCli(
          ['bake', '--workspace', dir, '--cache', cache, '--only-invalidated', '--json'],
          c.io,
        ),
        0,
        c.err.join('\n'),
      );
      const after = await readWorkspace(dir);
      assert(
        after.lastBakeId !== firstId,
        `look.overrides is a cache input: ${after.lastBakeId} must differ from ${firstId}`,
      );
      assertEquals(
        after.look?.overrides,
        { alpha: { mode: 'soft', bleedPx: 4 } },
        'and the bake carried the override through rather than dropping it',
      );
      const rebaked = await bakeManifest(dir, after.lastBakeId!);
      assert(rebaked.frames.some((f) => !f.cacheHit), 'a changed recipe recomputes frames');
    });

    await t.step('--frames is the stub count, and deliberately does not persist', async () => {
      // Found by this acceptance failing on its first run, and pinned rather
      // than papered over. `--frames` feeds the P2-era idle-stub bake, whose
      // frame count IS part of the recipe but has no home in the manifest: the
      // PRD puts frames per CLIP, animationSet carries them there, and there is
      // deliberately no character-level frame count. So a stub bake that names
      // --frames is not reproducible from the workspace alone. The surprising
      // case should be a stated one.
      const before = await readWorkspace(dir);
      const c = collector();
      assertEquals(
        await runCli([
          'bake',
          '--workspace',
          dir,
          '--frames',
          '3',
          '--cache',
          cache,
          '--only-invalidated',
          '--json',
        ], c.io),
        0,
        c.err.join('\n'),
      );
      const after = await readWorkspace(dir);
      assert(after.lastBakeId !== before.lastBakeId, '--frames really is part of the stub recipe');
      assertEquals(
        after.look,
        before.look,
        'and nothing about it was recorded, because it cannot be',
      );
    });
  } finally {
    await Deno.remove(raw, { recursive: true });
  }
});

Deno.test('acceptance: the bake manifest records the backend that really made it', async () => {
  // Found by self-review: every other acceptance here uses a workspace with no
  // rig and no picked result, so `provenanceOf` returns undefined and the whole
  // manifest -> spec -> recipe -> BakeManifest.inputs path went unexercised.
  // `inputs` is a COMMITTED record - it is what "re-run exactly this" reads -
  // and it used to say `source-mesh@0` for a character a named backend made.
  if (!(await tryGetGpu())) return;
  const raw = await Deno.makeTempDir({ prefix: 'sb-prov-e2e-' });
  const dir = raw.replaceAll('\\', '/');
  try {
    await character(dir);
    const { appendGenerationResult, pickResult, setRigState } = await import('@spritebook/core');
    await appendGenerationResult(dir, {
      id: 'r1',
      backend: { modelId: 'trellis2', version: '4b' },
      params: { quality: 'high' },
      seed: 42,
      startedAt: NOW(),
      wallTimeS: 92.5,
      output: {
        gltfSha256: await sha256Bytes(await Deno.readFile(workspacePaths(dir).canonicalModel)),
        tris: 14318,
        kind: 'mesh',
      },
      discarded: false,
    }, { now: NOW });
    await pickResult(dir, 'r1', { heightM: 1.81, texturedBy: 'backend', now: NOW });
    await setRigState(dir, {
      track: 'B',
      skeletonProfile: 'generic',
      jointCount: 52,
      jointEdits: [],
      orientationFixes: [],
      accepted: true,
    }, { now: NOW });

    const c = collector();
    assertEquals(
      await runCli(
        ['bake', '--workspace', dir, '--directions', '2', '--cell', '48', '--json'],
        c.io,
      ),
      0,
      c.err.join('\n'),
    );
    const manifest = await readWorkspace(dir);
    const baked = await bakeManifest(dir, manifest.lastBakeId!);
    assertEquals(baked.inputs.backend.modelId, 'trellis2', 'not the source-mesh sentinel');
    assertEquals(baked.inputs.backend.version, '4b');
    assertEquals(
      baked.inputs.rigStateHash,
      await sha256Hex(canonicalJson(rigForKey(manifest.rig!))),
      'and the rig it is actually on — minus `accepted`, which D-031 keeps out',
    );
    // the same rig with the opposite acceptance hashes identically: pressing
    // Accept must not cost this character every frame it has
    assertEquals(
      await sha256Hex(
        canonicalJson(rigForKey({ ...manifest.rig!, accepted: !manifest.rig!.accepted })),
      ),
      baked.inputs.rigStateHash,
    );
  } finally {
    await Deno.remove(raw, { recursive: true });
  }
});

Deno.test('bake says so, loudly, when the rig was never accepted', async (t) => {
  // The P3 exit run shipped 48 frames off a rig whose own deform check had
  // flagged 37 of 40 joints and set accepted: false - and not one line said so
  // at bake time. It cannot be a refusal: both rig tracks write accepted: false
  // ("theirs to set") and no verb sets it yet, so refusing would dead-end every
  // rigged character. Loud, actionable warn.
  if (!(await tryGetGpu())) return;
  const raw = await Deno.makeTempDir({ prefix: 'sb-rig-warn-' });
  const dir = raw.replaceAll('\\', '/');
  const geometry = ['--directions', '2', '--cell', '48', '--json'];
  const rig = {
    track: 'B' as const,
    skeletonProfile: 'generic' as const,
    jointCount: 40,
    jointEdits: [],
    orientationFixes: [],
    accepted: false,
  };
  try {
    await character(dir);

    await t.step('an unaccepted rig warns before the bake starts', async () => {
      await setRigState(dir, rig, { now: NOW });
      const c = collector();
      assertEquals(await runCli(['bake', '--workspace', dir, ...geometry], c.io), 0);
      const warns = c.out.filter((l) => l.includes('"rig-unaccepted"'));
      assertEquals(warns.length, 1, `exactly one warn: ${c.out.join('\n')}`);
      assert(warns[0].includes('40 joints'), `names the rig: ${warns[0]}`);
      assert(warns[0].includes('--edits'), `names the repair path: ${warns[0]}`);
      // loud is not fatal: the bake itself must still have completed
      assert(c.out.some((l) => l.includes('"done"')), 'the bake still ran');
    });

    await t.step('an accepted rig bakes without the warning', async () => {
      await setRigState(dir, { ...rig, accepted: true }, { now: NOW });
      const c = collector();
      assertEquals(await runCli(['bake', '--workspace', dir, ...geometry], c.io), 0);
      assertEquals(
        c.out.filter((l) => l.includes('"rig-unaccepted"')).length,
        0,
        'acceptance silences it',
      );
    });
  } finally {
    await Deno.remove(raw, { recursive: true });
  }
});
