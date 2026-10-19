import { promises as fs } from 'node:fs';
import { mkdirSync } from 'node:fs';
/**
 * Per-frame pixel cache for the bake stage (D-011: hash inputs, never pixels).
 *
 * The style stage is CLIP-ATOMIC — the palette pools over every frame and
 * hysteresis chains within a direction — so a frame's pixels are a function of
 * the ENTIRE recipe, not just its own coordinates. Every frame key therefore
 * embeds the full bake-level key (contracts.ts recipe):
 *
 *   frameKey = sha256Hex(canonicalJson({ bake, clipId, direction, frame }))
 *
 * Consequences, all intended:
 *  - any look/recipe change flips `bake` -> EVERY frame key misses (exactly
 *    what the look stage predicts, because the palette depends on every frame);
 *  - an unchanged rebake hits every key;
 *  - a rename cannot reach the key at all (core's displayName guarantee).
 *
 * predictInvalidation is the testable form of that prediction: it returns the
 * frame set whose keys change between two recipes. Today that is all-or-none
 * (every frame key embeds the same bake key); when finer-grained stages land
 * (per-clip hashes in the anim package), the prediction refines with the keys.
 */
import { computeCacheKey, sha256Hex } from '@spritebook/core';
import { type CacheKeyInputs, canonicalJson, type RigState } from '@spritebook/schema';
import type { FrameId } from './contracts.ts';

/**
 * The rig as the CACHE sees it (D-031): everything except `accepted`.
 *
 * `RigState.accepted` is a human judgement recorded by `spritebook rig
 * --accept`. Nothing reads it to change a pixel — the only readers are the
 * bake's unaccepted-rig warning, the verb's own idempotence check, and GUI
 * badges — while every geometric consequence of rigging (the skeleton, the
 * weights, applied joint edits, applied orientation fixes) is promoted into
 * `canonical/model.glb` and therefore already covered by
 * `canonicalMeshSha256`. Hashing it made pressing Accept cost a full re-bake:
 * an annoyance at one character, a hundred re-bakes bought with a click at
 * roster scale, and the exact class of surprise P4-T3 exists to remove.
 *
 * Written as an OMISSION rather than a list of fields to keep. That direction
 * matters: a field added to RigState tomorrow is hashed by default, so the
 * failure mode of forgetting to update this function is a spurious cache miss
 * (annoying, visible, safe) rather than stale pixels served under a key that
 * never heard of the thing that changed.
 */
export function rigForKey(rig: RigState): Omit<RigState, 'accepted'> {
  const { accepted: _accepted, ...geometric } = rig;
  return geometric;
}

/** The 64-hex bake-level key (sha256 of canonical CacheKeyInputs). */
export function bakeKey(inputs: CacheKeyInputs): Promise<string> {
  return computeCacheKey(inputs);
}

/** The 64-hex per-frame key: full recipe + frame coordinates. */
export function frameKey(bake: string, id: FrameId): Promise<string> {
  return sha256Hex(
    canonicalJson({ bake, clipId: id.clipId, direction: id.direction, frame: id.frame }),
  );
}

/** A named per-bake artifact key (aov pages, style-result) on the same recipe. */
export function artifactKey(bake: string, artifact: string): Promise<string> {
  return sha256Hex(canonicalJson({ artifact, bake }));
}

/**
 * Frames whose cache keys change between two recipes. Empty when the recipes
 * are canonically identical; otherwise every frame (the bake key is embedded in
 * each frame key, and clip-atomic styling makes that the true dependency).
 */
export function predictInvalidation(
  oldInputs: CacheKeyInputs,
  newInputs: CacheKeyInputs,
  frames: FrameId[],
): FrameId[] {
  return canonicalJson(oldInputs) === canonicalJson(newInputs) ? [] : [...frames];
}

/**
 * Binary blob store, one file per 64-hex key (`<dir>/<key>.bin`). Core's
 * DiskCacheStore is text-only; baked pixels are PNG bytes, so pack keeps its
 * own store with the same key discipline (invalid keys throw, never miss).
 */
export class BlobCache {
  #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  #path(key: string): string {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('cache keys are sha256 hex');
    return `${this.#dir}/${key}.bin`;
  }

  async has(key: string): Promise<boolean> {
    const path = this.#path(key);
    try {
      await fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const path = this.#path(key);
    try {
      return new Uint8Array(await fs.readFile(path));
    } catch {
      return undefined;
    }
  }

  /**
   * ATOMIC put: write to a temp sibling then rename into place. A crash mid-put
   * can therefore never leave a torn value under a valid key — without this, a
   * torn frame blob next to an intact style-result commit marker would poison
   * every later warm bake of the recipe (adversarial review M2).
   */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.#path(key);
    const tmp = `${path}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, path);
  }
}
