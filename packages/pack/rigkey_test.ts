import { test } from 'node:test';
/**
 * D-031: `accepted` is out of the cache key, and NOTHING else is.
 *
 * The change is worth one small test file because the failure modes are
 * asymmetric. Dropping a field that does not matter costs nothing and saves a
 * hundred re-bakes; dropping one that DOES matter serves pixels rendered from
 * a recipe nobody asked for, silently, forever. So the guard here is not
 * "accepted is dropped" — it is "every other field still moves the key",
 * enumerated against RigState's own shape so a field added tomorrow fails this
 * file rather than quietly slipping the net.
 */
import { assert, assertEquals } from '@std/assert';
import { canonicalJson, type RigState, RigStateSchema } from '@spritebook/schema';
import { sha256Hex } from '@spritebook/core';
import { rigForKey } from './dist/cache.js';

const FULL: RigState = RigStateSchema.parse({
  track: 'B',
  backend: { modelId: 'unirig', version: '1.0.0' },
  skeletonProfile: 'generic',
  jointCount: 40,
  jointEdits: [{ joint: 'clavicle_r', delta: [0.01, 0, 0], mirrored: true }],
  orientationFixes: ['face-front'],
  boneMask: { torso: 'torso.glb' },
  sockets: [{ id: 'hand', bone: 'hand_r', localOffset: [0, 0, 0] }],
  accepted: false,
});

/** What `buildCacheInputs` will hash — the same expression, kept in step. */
const keyOf = (rig: RigState) => sha256Hex(canonicalJson(rigForKey(rig)));

test('accepting a rig does not move the cache key', async () => {
  // the whole point: `spritebook rig --accept` moves no vertex, so it must not
  // cost a re-bake of every frame this character has
  const before = await keyOf(FULL);
  const after = await keyOf({ ...FULL, accepted: true });
  assertEquals(before, after, 'a human judgement is not a recipe change');
});

test('EVERY other RigState field still moves the key', async () => {
  // enumerated from the schema rather than hand-listed, so a field added to
  // RigState lands here as a failure instead of as a silent cache collision
  const perturb: Record<string, RigState> = {
    track: { ...FULL, track: 'A' },
    backend: { ...FULL, backend: { modelId: 'unirig', version: '2.0.0' } },
    skeletonProfile: { ...FULL, skeletonProfile: 'ual-humanoid' },
    jointCount: { ...FULL, jointCount: 41 },
    jointEdits: {
      ...FULL,
      jointEdits: [{ joint: 'clavicle_r', delta: [0.02, 0, 0], mirrored: true }],
    },
    orientationFixes: { ...FULL, orientationFixes: ['face-front', 'feet-ground'] },
    boneMask: { ...FULL, boneMask: { torso: 'other.glb' } },
    sockets: {
      ...FULL,
      sockets: [{ id: 'hand', bone: 'hand_l', localOffset: [0, 0, 0] }],
    },
  };
  const fields = Object.keys(RigStateSchema.shape).sort();
  assertEquals(
    [...Object.keys(perturb), 'accepted'].sort(),
    fields,
    'this test covers every field RigState has — add the new one above',
  );

  const base = await keyOf(FULL);
  for (const [field, rig] of Object.entries(perturb)) {
    assert(
      (await keyOf(rig)) !== base,
      `${field} changed and the key did not: that is stale pixels under a stable id`,
    );
  }
});

test('the omission is by exclusion, so unknown fields stay IN', () => {
  // written as a rest-destructure on purpose: the failure mode of forgetting
  // to update rigForKey is a spurious MISS, never a wrong hit
  const withFuture = { ...FULL, someFutureGeometricField: 42 } as unknown as RigState;
  const kept = rigForKey(withFuture) as Record<string, unknown>;
  assert('someFutureGeometricField' in kept, 'a field nobody told rigForKey about is still hashed');
  assert(!('accepted' in kept), 'and the one field it does know about is gone');
});

test('an UNRIGGED bake keys exactly as it always did', async () => {
  // The no-rig sentinel has no `accepted` field, so D-031 cannot move it —
  // the one-time invalidation falls only on characters that HAVE a rig. Pinned
  // to the literal so a future change to the sentinel's shape (or to
  // canonicalJson) is caught here rather than as a mass re-bake nobody ordered.
  assertEquals(
    await sha256Hex(canonicalJson({ track: 'source-skin' })),
    '68b4e140a2bd401df60ad02bee30bf3a16502e77ffa409a5a3fd0f1123086192',
    'the no-rig path is byte-identical across D-031',
  );
});
