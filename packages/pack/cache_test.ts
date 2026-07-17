import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import type { CacheKeyInputs } from '@spritebook/schema';
import { artifactKey, bakeKey, BlobCache, frameKey, predictInvalidation } from './cache.ts';
import { frameGrid } from './manifest.ts';

function inputs(over: Partial<CacheKeyInputs> = {}): CacheKeyInputs {
  return {
    characterId: 'test-char',
    canonicalMeshSha256: 'a'.repeat(64),
    rigStateHash: 'b'.repeat(64),
    clipBindingHash: 'c'.repeat(64),
    cameraPresetHash: 'd'.repeat(64),
    stylePresetHash: 'e'.repeat(64),
    rendererVersion: 'spritebook-render@0.1.0',
    backend: { modelId: 'source-mesh', version: '0', paramsHash: 'f'.repeat(64) },
    ...over,
  } as CacheKeyInputs;
}

Deno.test('frame keys: deterministic, distinct per coordinate, recipe-bound', async () => {
  const bake = await bakeKey(inputs());
  assert(/^[0-9a-f]{64}$/.test(bake));
  const k1 = await frameKey(bake, { clipId: 'idle', direction: 0, frame: 0 });
  const k1b = await frameKey(bake, { clipId: 'idle', direction: 0, frame: 0 });
  const k2 = await frameKey(bake, { clipId: 'idle', direction: 0, frame: 1 });
  const k3 = await frameKey(bake, { clipId: 'idle', direction: 1, frame: 0 });
  assertEquals(k1, k1b, 'deterministic');
  assert(k1 !== k2 && k1 !== k3 && k2 !== k3, 'distinct per frame coordinate');
  // a recipe change (outline width -> stylePresetHash) flips every frame key
  const bake2 = await bakeKey(inputs({ stylePresetHash: '9'.repeat(64) }));
  assert(bake2 !== bake);
  assert(await frameKey(bake2, { clipId: 'idle', direction: 0, frame: 0 }) !== k1);
  // artifact keys live in a distinct namespace
  assert(await artifactKey(bake, 'style-result') !== k1);
});

Deno.test('predictInvalidation: none when unchanged, all frames on a look change', () => {
  const grid = frameGrid(2, 3);
  assertEquals(predictInvalidation(inputs(), inputs(), grid), [], 'identical recipe -> none');
  const changed = predictInvalidation(inputs(), inputs({ stylePresetHash: '9'.repeat(64) }), grid);
  assertEquals(changed.length, 6, 'look change -> every frame (clip-atomic style)');
  assertEquals(changed, grid);
});

Deno.test('BlobCache: binary round-trip, misses, key discipline', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const cache = new BlobCache(dir);
    const key = 'ab'.repeat(32);
    assertEquals(await cache.has(key), false);
    assertEquals(await cache.get(key), undefined);
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    await cache.put(key, bytes);
    assertEquals(await cache.has(key), true);
    assertEquals([...(await cache.get(key))!], [...bytes]);
    // invalid keys throw — they are never silent misses
    await assertRejects(() => cache.get('not-a-key'), Error, 'sha256 hex');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
