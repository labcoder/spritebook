/**
 * The two facts a glb cannot state — which rig the character is on, and which
 * backend produced it — reach the bake recipe (D-029 follow-through).
 *
 * Both were hardcoded sentinels: `{track:'source-skin'}` and `source-mesh@0`,
 * under comments saying the rig stage "lands with Track B" and there is "no
 * generation backend in the T3 path". Both of those worlds ended in P3. What
 * they cost was truth in a committed artifact: `BakeManifest.inputs` is the
 * record of what a bake ran on, and "re-run exactly this" cannot be honoured
 * from one naming the wrong backend for the model it baked.
 *
 * CPU-only: this pins the key inputs, not pixels.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { CameraPreset, RigState } from '@spritebook/schema';
import { canonicalJson } from '@spritebook/schema';
import { sha256Hex } from '@spritebook/core';
import { PIXEL_8 } from '@spritebook/style';
import { type BakeProvenance, buildCacheInputs } from './bake.ts';

const MODEL = new URL('../anim/fixtures/humanoid-normal.glb', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const CAM: CameraPreset = {
  id: 'provenance-30x2',
  elevationDeg: 30,
  directions: 2,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32,
  cellPx: { w: 64, h: 64 },
  paddingPx: 6,
  pivot: 'feet-baseline',
  orthographic: true,
};
const SIG = 'test-signature';

const spec = { characterId: 'c', modelPath: MODEL, camera: CAM, style: PIXEL_8, frames: 2 };

const RIG: RigState = {
  track: 'B',
  backend: { modelId: 'unirig', version: '1.0' },
  skeletonProfile: 'generic',
  jointCount: 52,
  jointEdits: [],
  orientationFixes: [],
  accepted: true,
};

const BACKEND: NonNullable<BakeProvenance['backend']> = {
  modelId: 'trellis2',
  version: '4b',
  params: { quality: 'high' },
};

Deno.test('with no character to ask, the sentinels say so and nothing changed', async () => {
  // The bare-file bake (`bake --model x.glb`) genuinely has no rig and no
  // backend, so the sentinels are the TRUE answer there - and every P2-era
  // cache entry for that path stays valid, which is why this is pinned.
  const bare = await buildCacheInputs(spec, SIG);
  assertEquals(bare.rigStateHash, await sha256Hex(canonicalJson({ track: 'source-skin' })));
  assertEquals(bare.backend.modelId, 'source-mesh');
  assertEquals(bare.backend.version, '0');
  assertEquals(bare.backend.paramsHash, await sha256Hex(canonicalJson({})));
  // and an EMPTY provenance object is the same statement, not a third state
  assertEquals(await buildCacheInputs(spec, SIG, {}), bare);
});

Deno.test('the rig reaches the key, and a joint nudge moves it', async () => {
  const bare = await buildCacheInputs(spec, SIG);
  const rigged = await buildCacheInputs(spec, SIG, { rig: RIG });
  assertEquals(rigged.rigStateHash, await sha256Hex(canonicalJson(RIG)));
  assert(rigged.rigStateHash !== bare.rigStateHash, 'a rig is not "no rig"');

  // A tier-1 repair changes the pose and therefore the pixels. Under the
  // sentinel this hashed identically to every other rig state, so the only
  // thing invalidating such a bake was whether the edit also rewrote the glb.
  const nudged = await buildCacheInputs(spec, SIG, {
    rig: { ...RIG, jointEdits: [{ joint: 'shoulder_l', delta: [0, 0.01, 0], mirrored: false }] },
  });
  assert(nudged.rigStateHash !== rigged.rigStateHash, 'a joint edit is a different rig');
});

Deno.test('the backend that made the character is recorded, params and all', async () => {
  const made = await buildCacheInputs(spec, SIG, { backend: BACKEND });
  assertEquals(made.backend.modelId, 'trellis2');
  assertEquals(made.backend.version, '4b');
  assertEquals(made.backend.paramsHash, await sha256Hex(canonicalJson({ quality: 'high' })));

  // same backend, different params -> a different recipe. `seed` lives in
  // params' sibling on the receipt, but everything the user adjusted is here.
  const other = await buildCacheInputs(spec, SIG, {
    backend: { ...BACKEND, params: { quality: 'draft' } },
  });
  assert(other.backend.paramsHash !== made.backend.paramsHash);
});

Deno.test('the two halves are independent, because a character can have one', async () => {
  // `rig` works on a bare glb, so a character can carry a rig with no picked
  // result; and a freshly picked mesh has no rig yet. Neither half may drag
  // the other's sentinel along with it.
  const rigOnly = await buildCacheInputs(spec, SIG, { rig: RIG });
  assertEquals(rigOnly.backend.modelId, 'source-mesh', 'still not generated here');

  const backendOnly = await buildCacheInputs(spec, SIG, { backend: BACKEND });
  assertEquals(
    backendOnly.rigStateHash,
    await sha256Hex(canonicalJson({ track: 'source-skin' })),
    'still no recorded rig',
  );

  const both = await buildCacheInputs(spec, SIG, { rig: RIG, backend: BACKEND });
  assertEquals(both.rigStateHash, rigOnly.rigStateHash);
  assertEquals(both.backend, backendOnly.backend);
});

Deno.test('renaming a character cannot reach the key at all', async () => {
  // The property deriveCacheKeyInputs used to carry: displayName is not in
  // CacheKeyInputs and the schema is strict, so a rename is unable to
  // invalidate anything by construction rather than by care.
  const inputs = await buildCacheInputs(spec, SIG, { rig: RIG, backend: BACKEND });
  assert(!('displayName' in inputs), 'not a field a bake recipe has');
  assertEquals(inputs.characterId, 'c', 'identity binds on the immutable id');
});

Deno.test('ACCEPTANCE: renaming a character invalidates nothing, through the real verb', async () => {
  // This lived in core/cache_test.ts and core/roster_test.ts against
  // `deriveCacheKeyInputs`, which no production path called. It belongs against
  // the derivation the bake actually runs. Renaming is the one mutation that
  // must never cost a user a re-bake, and `displayName` is not merely absent
  // from the recipe - CacheKeyInputs is strict, so it cannot be expressed.
  const { createWorkspace, readWorkspace, renameCharacter } = await import('@spritebook/core');
  const raw = await Deno.makeTempDir({ prefix: 'sb-rename-key-' });
  const ws = raw.replaceAll('\\', '/');
  try {
    await createWorkspace({
      workspace: ws,
      characterId: 'brave-knight',
      displayName: 'Original Name',
      source: { kind: 'mesh', originalFilename: 'humanoid.glb', sha256: 'a'.repeat(64) },
      now: () => '2026-07-12T00:00:00Z',
    });
    const before = await readWorkspace(ws);
    const keyBefore = await buildCacheInputs({ ...spec, characterId: before.id }, SIG, {
      rig: RIG,
      backend: BACKEND,
    });

    const after = await renameCharacter(ws, 'Totally Different Name', {
      now: () => '2026-07-12T00:00:00Z',
    });
    assertEquals(after.displayName, 'Totally Different Name');

    const keyAfter = await buildCacheInputs({ ...spec, characterId: after.id }, SIG, {
      rig: RIG,
      backend: BACKEND,
    });
    assertEquals(
      keyAfter,
      keyBefore,
      'every cached frame of this character is still valid after a rename',
    );
  } finally {
    await Deno.remove(raw, { recursive: true });
  }
});
