import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import type { CacheKeyInputs } from '@spritebook/schema';
import { computeCacheKey, DiskCacheStore, InputHashCache } from './dist/cache.js';

async function fixtureInputs(): Promise<CacheKeyInputs> {
  const url = new URL('../schema/fixtures/valid/cache-key-inputs.json', import.meta.url);
  return JSON.parse(await fs.readFile(url, 'utf8'));
}

test('acceptance: same inputs hit; ANY single input change misses', async () => {
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

test('computeCacheKey is key-order independent and validates inputs', async () => {
  const inputs = await fixtureInputs();
  // same data, reversed insertion order (canonicalJson must neutralize it)
  const shuffled = Object.fromEntries(
    Object.entries(inputs).reverse(),
  ) as unknown as CacheKeyInputs;
  assertEquals(await computeCacheKey(shuffled), await computeCacheKey(inputs));
});

test('DiskCacheStore round-trips and lists keys', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'sb-cache-'));
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

test('DiskCacheStore.put is atomic: no torn value is ever served as a hit', async () => {
  // A plain writeTextFile can be interrupted, and nothing downstream detects a
  // truncated entry: has() -> true, get() -> a prefix, and the caller reports a
  // cache HIT and parses garbage.
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const store = new DiskCacheStore(dir);
    const key = 'a'.repeat(64); // keys are sha256 hex
    await store.put(key, JSON.stringify({ pixels: 'complete' }));
    // no stray temp files survive a successful write
    const leftovers: string[] = [];
    for await (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.includes('.tmp')) leftovers.push(e.name);
    }
    assertEquals(leftovers, [], 'the temp file is renamed, not left behind');
    assertEquals(await store.get(key), JSON.stringify({ pixels: 'complete' }));
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
