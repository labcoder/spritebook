/**
 * Input-hash cache (D-011): keys are sha256 over canonical CacheKeyInputs —
 * inputs, never pixels; bound to the immutable characterId. Renaming a
 * character (displayName) can never invalidate anything because displayName
 * cannot even be expressed in CacheKeyInputs (schema-strict + type-asserted).
 */
import type { CacheKeyInputs } from '@spritebook/schema';
import { CacheKeyInputsSchema, canonicalJson, parseWith } from '@spritebook/schema';

export async function sha256Hex(text: string): Promise<string> {
  return await sha256Bytes(new TextEncoder().encode(text));
}

/**
 * The same digest over raw bytes — for hashing a file rather than a canonical
 * string. Named apart from `sha256Hex` deliberately: `rig/fitjob.ts` used to
 * carry a LOCAL `sha256Hex(bytes: Uint8Array)` that shadowed the exported
 * `sha256Hex(text: string)`, so the two differed only in a parameter type at a
 * call site that read identically either way.
 */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The cache key: sha256 of the canonical serialization of validated inputs. */
export async function computeCacheKey(inputs: CacheKeyInputs): Promise<string> {
  const valid = parseWith(CacheKeyInputsSchema, inputs, 'CacheKeyInputs');
  return await sha256Hex(canonicalJson(valid));
}

/**
 * ## Where the recipe is derived
 *
 * `buildCacheInputs` in @spritebook/pack, and only there. A second derivation
 * lived here — `deriveCacheKeyInputs`, manifest-in — with zero production
 * callers, and it was weaker in three ways that mattered: it hashed clip
 * BINDINGS with no clip content (so an in-place pack upgrade served stale
 * pixels, review F1), it trusted `canonicalMesh.gltfSha256` (what the manifest
 * CLAIMS) over the bytes on disk, and it required a rig, a mesh and a picked
 * result, so it could not describe `bake --model x.glb` at all.
 *
 * Two derivations of one key is a hole waiting for a caller to pick the wrong
 * one, so the weaker went. What it had that the survivor lacked — the real rig
 * and the real backend — moved across as `BakeProvenance`.
 */

export interface CacheStore {
  has(key: string): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  keys(): Promise<string[]>;
}

export class MemoryCacheStore implements CacheStore {
  #map = new Map<string, string>();

  has(key: string): Promise<boolean> {
    return Promise.resolve(this.#map.has(key));
  }
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.#map.get(key));
  }
  put(key: string, value: string): Promise<void> {
    this.#map.set(key, value);
    return Promise.resolve();
  }
  keys(): Promise<string[]> {
    return Promise.resolve([...this.#map.keys()]);
  }
}

/** One file per key under a directory — the on-disk shape core will grow into. */
export class DiskCacheStore implements CacheStore {
  #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    Deno.mkdirSync(dir, { recursive: true });
  }

  #path(key: string): string {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('cache keys are sha256 hex');
    return `${this.#dir}/${key}.json`;
  }

  async has(key: string): Promise<boolean> {
    const path = this.#path(key); // invalid keys throw, they are not misses
    try {
      await Deno.stat(path);
      return true;
    } catch {
      return false;
    }
  }
  async get(key: string): Promise<string | undefined> {
    const path = this.#path(key); // invalid keys throw, they are not misses
    try {
      return await Deno.readTextFile(path);
    } catch {
      return undefined;
    }
  }
  async put(key: string, value: string): Promise<void> {
    // tmp + rename, the same discipline pack/cache.ts's BlobCache uses: a plain
    // write can be interrupted, and a torn value is not detected on the way
    // back out - `has()` returns true and `get()` returns a prefix, so the
    // caller reports a cache HIT and parses garbage. Rename is atomic, so an
    // entry either exists whole or not at all.
    const final = this.#path(key);
    const tmp = `${final}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeTextFile(tmp, value);
      await Deno.rename(tmp, final);
    } catch (err) {
      await Deno.remove(tmp).catch(() => {});
      throw err;
    }
  }
  async keys(): Promise<string[]> {
    const out: string[] = [];
    for await (const e of Deno.readDir(this.#dir)) {
      if (e.isFile && e.name.endsWith('.json')) out.push(e.name.slice(0, -5));
    }
    return out.sort();
  }
}

export interface CacheLookup {
  key: string;
  hit: boolean;
  value?: string;
}

/** Content-addressed cache over validated CacheKeyInputs. */
export class InputHashCache {
  #store: CacheStore;

  constructor(store: CacheStore = new MemoryCacheStore()) {
    this.#store = store;
  }

  async lookup(inputs: CacheKeyInputs): Promise<CacheLookup> {
    const key = await computeCacheKey(inputs);
    const value = await this.#store.get(key);
    return { key, hit: value !== undefined, value };
  }

  async put(inputs: CacheKeyInputs, value: string): Promise<string> {
    const key = await computeCacheKey(inputs);
    await this.#store.put(key, value);
    return key;
  }

  keys(): Promise<string[]> {
    return this.#store.keys();
  }
}
