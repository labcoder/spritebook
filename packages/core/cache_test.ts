import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import type { CacheKeyInputs, CharacterManifest } from '@spritebook/schema';
import { CharacterManifestSchema, parseWith } from '@spritebook/schema';
import { computeCacheKey, deriveCacheKeyInputs, DiskCacheStore, InputHashCache } from './cache.ts';
import { ManifestJournal } from './journal.ts';

async function fixtureInputs(): Promise<CacheKeyInputs> {
  const url = new URL('../schema/fixtures/valid/cache-key-inputs.json', import.meta.url);
  return JSON.parse(await Deno.readTextFile(url));
}

async function fixtureManifest(): Promise<CharacterManifest> {
  const url = new URL('../schema/fixtures/valid/character-manifest.json', import.meta.url);
  return parseWith(
    CharacterManifestSchema,
    JSON.parse(await Deno.readTextFile(url)),
    'CharacterManifest fixture',
  );
}

Deno.test('acceptance: same inputs hit; ANY single input change misses', async () => {
  const cache = new InputHashCache();
  const inputs = await fixtureInputs();
  await cache.put(inputs, 'bake-e41c');

  const again = await cache.lookup(structuredClone(inputs));
  assert(again.hit, 'identical inputs are a hit');
  assertEquals(again.value, 'bake-e41c');

  // property sweep: flipping any single scalar leaf forces a miss
  const leaves: Array<[string[], unknown]> = [
    [['characterId'], 'other-knight'],
    [['canonicalMeshSha256'], '9'.repeat(64)],
    [['rigStateHash'], '9'.repeat(64)],
    [['clipBindingHash'], '9'.repeat(64)],
    [['cameraPresetHash'], '9'.repeat(64)],
    [['stylePresetHash'], '9'.repeat(64)],
    [['rendererVersion'], '0.2.0'],
    [['backend', 'modelId'], 'trellis2'],
    [['backend', 'version'], '9.9'],
    [['backend', 'paramsHash'], '9'.repeat(64)],
  ];
  for (const [path, value] of leaves) {
    const mutated = structuredClone(inputs) as unknown as Record<string, unknown>;
    let node: Record<string, unknown> = mutated;
    for (const seg of path.slice(0, -1)) node = node[seg] as Record<string, unknown>;
    node[path[path.length - 1]] = value;
    const miss = await cache.lookup(mutated as unknown as CacheKeyInputs);
    assert(!miss.hit, `mutating ${path.join('.')} must miss`);
    assertNotEquals(miss.key, again.key);
  }
});

Deno.test('acceptance: displayName rename causes ZERO cache invalidation', async () => {
  const manifest = await fixtureManifest();
  const resolved = {
    cameraPreset: { id: 'cam' },
    stylePreset: { id: 'style' },
    rendererVersion: '0.1.0',
  };
  const cache = new InputHashCache();

  const before = await deriveCacheKeyInputs(manifest, resolved);
  const key = await cache.put(before, 'bake-e41c');

  // rename through the real journal path (the only sanctioned mutation route)
  const journal = new ManifestJournal(
    manifest as unknown as Record<string, unknown>,
    { now: () => '2026-07-12T00:00:00Z' },
  );
  journal.commit({
    target: { kind: 'character', id: 'brave-knight' },
    op: [{ op: 'replace', path: '/displayName', value: 'Completely New Name' }],
    label: 'Rename',
  });
  const renamed = parseWith(CharacterManifestSchema, journal.doc, 'renamed manifest');
  assertEquals(renamed.displayName, 'Completely New Name');

  const after = await deriveCacheKeyInputs(renamed, resolved);
  assertEquals(after, before, 'derived inputs identical after rename');
  const lookup = await cache.lookup(after);
  assert(lookup.hit, 'rename never invalidates');
  assertEquals(lookup.key, key);
  assertEquals((await cache.keys()).length, 1, 'no new entries, nothing evicted');
});

Deno.test('computeCacheKey is key-order independent and validates inputs', async () => {
  const inputs = await fixtureInputs();
  // same data, reversed insertion order (canonicalJson must neutralize it)
  const shuffled = Object.fromEntries(
    Object.entries(inputs).reverse(),
  ) as unknown as CacheKeyInputs;
  assertEquals(await computeCacheKey(shuffled), await computeCacheKey(inputs));
});

Deno.test('DiskCacheStore round-trips and lists keys', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'sb-cache-' });
  const store = new DiskCacheStore(dir);
  const cache = new InputHashCache(store);
  const inputs = await fixtureInputs();

  const empty = await cache.lookup(inputs);
  assert(!empty.hit, 'empty store misses');
  assertEquals(await store.has('f'.repeat(64)), false);
  assertEquals(await store.get('f'.repeat(64)), undefined);

  const key = await cache.put(inputs, 'payload');
  const found = await cache.lookup(inputs);
  assert(found.hit);
  assertEquals(found.value, 'payload');
  assertEquals(await store.has(key), true);
  assertEquals(await cache.keys(), [key]);

  let guarded = false;
  try {
    await store.get('not-a-sha');
  } catch (err) {
    guarded = true;
    assert(String(err).includes('sha256'));
  }
  assert(guarded, 'non-hash keys are rejected');
});

Deno.test('deriveCacheKeyInputs refuses manifests missing structural stages', async () => {
  const manifest = await fixtureManifest();
  const resolved = { cameraPreset: {}, stylePreset: {}, rendererVersion: '0.1.0' };
  const noMesh = { ...manifest, canonicalMesh: undefined };
  let threw = false;
  try {
    await deriveCacheKeyInputs(noMesh as CharacterManifest, resolved);
  } catch (err) {
    threw = true;
    assert(String(err).includes('canonical mesh'));
  }
  assert(threw);
});
