/**
 * Input-hash cache (D-011): keys are sha256 over canonical CacheKeyInputs —
 * inputs, never pixels; bound to the immutable characterId. Renaming a
 * character (displayName) can never invalidate anything because displayName
 * cannot even be expressed in CacheKeyInputs (schema-strict + type-asserted).
 */
import type { CacheKeyInputs, CharacterManifest } from '@spritebook/schema';
import { CacheKeyInputsSchema, canonicalJson, parseWith } from '@spritebook/schema';

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The cache key: sha256 of the canonical serialization of validated inputs. */
export async function computeCacheKey(inputs: CacheKeyInputs): Promise<string> {
  const valid = parseWith(CacheKeyInputsSchema, inputs, 'CacheKeyInputs');
  return await sha256Hex(canonicalJson(valid));
}

/**
 * Derive CacheKeyInputs from a character manifest + resolved presets.
 * Reads structural state only — displayName is not an input by construction.
 */
export async function deriveCacheKeyInputs(
  manifest: CharacterManifest,
  resolved: {
    cameraPreset: unknown;
    stylePreset: unknown;
    rendererVersion: string;
  },
): Promise<CacheKeyInputs> {
  if (!manifest.canonicalMesh) throw new Error('deriveCacheKeyInputs: no canonical mesh yet');
  if (!manifest.rig) throw new Error('deriveCacheKeyInputs: no rig state yet');
  const picked = manifest.generation.results.find(
    (r) => r.id === manifest.generation.pickedResultId,
  );
  if (!picked) throw new Error('deriveCacheKeyInputs: no picked generation result');
  return parseWith(CacheKeyInputsSchema, {
    characterId: manifest.id,
    canonicalMeshSha256: manifest.canonicalMesh.gltfSha256,
    rigStateHash: await sha256Hex(canonicalJson(manifest.rig)),
    clipBindingHash: await sha256Hex(canonicalJson(manifest.animationSet ?? [])),
    cameraPresetHash: await sha256Hex(canonicalJson(resolved.cameraPreset)),
    stylePresetHash: await sha256Hex(canonicalJson(resolved.stylePreset)),
    rendererVersion: resolved.rendererVersion,
    backend: {
      modelId: picked.backend.modelId,
      version: picked.backend.version,
      paramsHash: await sha256Hex(canonicalJson(picked.params)),
    },
  }, 'derived CacheKeyInputs');
}

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
    await Deno.writeTextFile(this.#path(key), value);
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
