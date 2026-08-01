/**
 * The per-field staleness diff. Its contract is narrow and load-bearing:
 * every field of CacheKeyInputs must produce a reason (a field that moved
 * silently is a bake that re-ran for no stated cause), identical recipes must
 * produce none, and the answer must agree with `predictInvalidation` — the two
 * are the same question asked at different resolutions, and a disagreement
 * would mean the plan promised something the cache then contradicted.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { type CacheKeyInputs, CacheKeyInputsSchema, STALE_FIELDS } from '@spritebook/schema';
import { diffCacheInputs } from './plan.ts';
import { predictInvalidation } from './cache.ts';
import type { FrameId } from './contracts.ts';

const h = (c: string) => c.repeat(64);

const BASE: CacheKeyInputs = CacheKeyInputsSchema.parse({
  characterId: 'bulma',
  canonicalMeshSha256: h('a'),
  rigStateHash: h('b'),
  clipBindingHash: h('c'),
  cameraPresetHash: h('d'),
  stylePresetHash: h('e'),
  lightRigHash: h('f'),
  rendererVersion: 'r1#0011aabb',
  backend: { modelId: 'trellis2', version: '1.0.0', paramsHash: h('1') },
});

const FRAMES: FrameId[] = [
  { clipId: 'idle-loop', direction: 0, frame: 0 },
  { clipId: 'idle-loop', direction: 1, frame: 0 },
];

Deno.test('an unchanged recipe is stale in nothing', () => {
  assertEquals(diffCacheInputs(BASE, { ...BASE }), []);
  // key ORDER is not a change: the diff reads fields by name, so a manifest
  // written by an older writer with a different key order is not "stale"
  const reordered = Object.fromEntries(
    Object.entries(BASE).reverse(),
  ) as unknown as CacheKeyInputs;
  assertEquals(diffCacheInputs(BASE, reordered), []);
});

Deno.test('EVERY field of the recipe can explain itself', () => {
  // the guard that keeps this honest as CacheKeyInputs grows: a new field with
  // no reason would move the key while the plan said nothing changed
  const moved: Record<string, CacheKeyInputs> = {
    characterId: { ...BASE, characterId: 'trunks' as CacheKeyInputs['characterId'] },
    canonicalMeshSha256: { ...BASE, canonicalMeshSha256: h('9') },
    rigStateHash: { ...BASE, rigStateHash: h('9') },
    clipBindingHash: { ...BASE, clipBindingHash: h('9') },
    cameraPresetHash: { ...BASE, cameraPresetHash: h('9') },
    stylePresetHash: { ...BASE, stylePresetHash: h('9') },
    lightRigHash: { ...BASE, lightRigHash: h('9') },
    rendererVersion: { ...BASE, rendererVersion: 'r1#ffffffff' },
    backend: { ...BASE, backend: { ...BASE.backend, version: '2.0.0' } },
  };
  assertEquals(
    Object.keys(moved).sort(),
    [...STALE_FIELDS].sort(),
    'every CacheKeyInputs field is covered here',
  );
  for (const [field, next] of Object.entries(moved)) {
    const reasons = diffCacheInputs(BASE, next);
    assertEquals(reasons.length, 1, `${field}: exactly one reason`);
    assertEquals(reasons[0]!.field, field);
    assert(reasons[0]!.why.length > 20, `${field}: the reason is a sentence, not a label`);
    assert(!reasons[0]!.why.includes(h('9')), `${field}: a raw hash is not an explanation`);
  }
});

Deno.test('the backend is ONE reason, not three', () => {
  // modelId, version and paramsHash always move together (a re-generation);
  // reporting a paramsHash flip apart from the model that produced it would
  // read as two unrelated causes
  const next = {
    ...BASE,
    backend: { modelId: 'pixal3d', version: '2.1.0', paramsHash: h('2') },
  };
  const reasons = diffCacheInputs(BASE, next);
  assertEquals(reasons.length, 1);
  assertEquals(reasons[0]!.field, 'backend');
  assertEquals(reasons[0]!.from, 'trellis2@1.0.0#11111111');
  assertEquals(reasons[0]!.to, 'pixal3d@2.1.0#22222222');
});

Deno.test('several changes report in intent order, not alphabetically', () => {
  const next: CacheKeyInputs = {
    ...BASE,
    rendererVersion: 'r1#ffffffff',
    stylePresetHash: h('9'),
    canonicalMeshSha256: h('9'),
  };
  assertEquals(
    diffCacheInputs(BASE, next).map((r) => r.field),
    ['canonicalMeshSha256', 'stylePresetHash', 'rendererVersion'],
    'what the user did comes before what their machine did',
  );
});

Deno.test('the diff and predictInvalidation never disagree', () => {
  // the plan is the explanation of the cache's own verdict; if one said
  // "nothing changed" while the other invalidated every frame, the plan would
  // be committing the user to work it told them would not happen
  const cases: CacheKeyInputs[] = [
    { ...BASE },
    { ...BASE, stylePresetHash: h('9') },
    { ...BASE, backend: { ...BASE.backend, paramsHash: h('9') } },
    { ...BASE, rendererVersion: 'r1#deadbeef' },
  ];
  for (const next of cases) {
    const empty = diffCacheInputs(BASE, next).length === 0;
    const frames = predictInvalidation(BASE, next, FRAMES);
    assertEquals(empty, frames.length === 0, `${canonical(next)}: the two verdicts agree`);
    // and when it IS stale, it is stale in ALL frames — the all-or-none
    // property the plan reports as staleFrames
    if (!empty) assertEquals(frames.length, FRAMES.length);
  }
});

function canonical(v: CacheKeyInputs): string {
  return `${v.stylePresetHash.slice(0, 4)}/${v.rendererVersion}/${
    v.backend.paramsHash.slice(0, 4)
  }`;
}

Deno.test('the rig reason promises a REAL skeleton change (D-031)', () => {
  // Before D-031, `accepted` was hashed with the rest of the rig, so pressing
  // Accept invalidated every frame and this reason had to hedge. Now the hash
  // excludes it (packages/pack/cache.ts `rigForKey`), so the sentence can
  // promise something — and this test is what keeps the promise true if
  // anyone puts the field back.
  const reasons = diffCacheInputs(BASE, { ...BASE, rigStateHash: h('9') });
  assert(
    reasons[0]!.why.includes('D-031'),
    `the rig reason cites the decision that makes it honest: ${reasons[0]!.why}`,
  );
  assert(
    !/accepting it/.test(reasons[0]!.why),
    'and no longer blames an acceptance that cannot reach the key',
  );
});
