/**
 * D-029 acceptance, on a real bake (GPU-gated; SPRITEBOOK_REQUIRE_GPU forces it
 * on the lavapipe lane):
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
import { createWorkspace, readWorkspace, recordBake, workspacePaths } from '@spritebook/core';
import { tryGetGpu } from '../render/gpu.ts';
import { runCli } from './mod.ts';

const GLB = new URL('../style/fixtures/asymmetric.glb', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const NOW = () => '2026-07-12T00:00:00Z';

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

Deno.test('acceptance: a workspace bake reproduces the last one exactly', async (t) => {
  if (!(await tryGetGpu())) return;
  const raw = await Deno.makeTempDir({ prefix: 'sb-bake-ws-' });
  const dir = raw.replaceAll('\\', '/');
  const cache = `${dir}/cache`;
  try {
    await createWorkspace({
      workspace: dir,
      characterId: 'brave-knight',
      displayName: 'Brave Knight',
      source: { kind: 'mesh', originalFilename: 'asymmetric.glb', sha256: 'a'.repeat(64) },
      now: NOW,
    });
    await Deno.copyFile(GLB, workspacePaths(dir).canonicalModel);

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
