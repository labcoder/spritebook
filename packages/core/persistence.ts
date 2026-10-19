import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, resolve } from 'node:path';
import type { CharacterManifest, JobEvent, JsonPatchOp, ManifestPatch } from '@spritebook/schema';
import {
  canonicalJson,
  CharacterManifestSchema,
  ManifestPatchSchema,
  migrateCharacterManifest,
  parseWith,
} from '@spritebook/schema';
import { applyPatchOps, ManifestJournal } from './journal.ts';
import { sha256Bytes } from './cache.ts';
import { resultPaths, workspacePaths } from './workspace.ts';

const held = new AsyncLocalStorage<Set<string>>();
interface State {
  doc: CharacterManifest;
  patches: ManifestPatch[];
  cursor: number;
  assetHash?: string | null;
}

/** OS locks release on process death. Never unlink the lock file (inode races). */
async function acquireLock(path: string) {
  let realDir: string;
  try {
    realDir = await Deno.realPath(dirname(resolve(path)));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    throw new Error(
      `No character manifest at "${path}" - that directory is not a SpriteBook workspace.`,
    );
  }
  const key = resolve(realDir, path.replaceAll('\\', '/').split('/').at(-1)!);
  const id = Deno.build.os === 'windows' ? key.toLowerCase() : key;
  const keys = new Set([...(held.getStore() ?? []), id]);
  if (held.getStore()?.has(id)) return { keys };
  const file = await Deno.open(`${key}.lock`, { create: true, read: true, write: true });
  try {
    await file.lock(true);
    return { keys, file };
  } catch (e) {
    file.close();
    throw e;
  }
}

export async function withManifestLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(path);
  try {
    return await held.run(lock.keys, run);
  } finally {
    lock.file?.close();
  }
}

/** Lock order: the long job lease, then the short recoverable state transaction. */
export async function withManifestWrite<T>(path: string, run: () => Promise<T>): Promise<T> {
  return await withManifestLock(`${path}.job`, run);
}

/** Keep generator work inside its lease, including cleanup after an early return. */
export async function* workspaceJob(
  workspace: string | undefined,
  run: () => AsyncIterable<JobEvent>,
): AsyncIterable<JobEvent> {
  if (!workspace) {
    yield* run();
    return;
  }
  await Deno.mkdir(workspace, { recursive: true });
  const lock = await acquireLock(`${workspacePaths(workspace).manifest}.job`);
  const iterator = run()[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await held.run(lock.keys, () => iterator.next());
      if (next.done) return;
      yield next.value;
    }
  } finally {
    try {
      await held.run(lock.keys, async () => {
        await iterator.return?.();
      });
    } finally {
      lock.file?.close();
    }
  }
}

/** Unique staging plus file sync; directory-entry durability is not promised on power loss. */
export async function writeAtomic(path: string, text: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeFile(tmp, typeof text === 'string' ? new TextEncoder().encode(text) : text, {
      createNew: true,
    });
    {
      using file = await Deno.open(tmp, { write: true });
      await file.sync();
    }
    await Deno.rename(tmp, path);
  } finally {
    await Deno.remove(tmp).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
  }
}

async function optionalText(path: string, fallback: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return fallback;
    throw e;
  }
}

function validateState(raw: State, path: string): State {
  const doc = parseWith(CharacterManifestSchema, migrateCharacterManifest(raw.doc), path);
  const patches = raw.patches.map((p) => parseWith(ManifestPatchSchema, p, 'journal patch'));
  if (!Number.isInteger(raw.cursor) || raw.cursor < 0 || raw.cursor > patches.length) {
    throw new Error(`corrupt cursor file at "${path}" (journal has ${patches.length} patches)`);
  }
  if (raw.assetHash !== undefined && raw.assetHash !== (doc.canonicalMesh?.gltfSha256 ?? null)) {
    throw new Error(`Pending asset selection disagrees with the manifest at "${path}"`);
  }
  return {
    doc,
    patches,
    cursor: raw.cursor,
    ...(raw.assetHash === undefined ? {} : { assetHash: raw.assetHash }),
  };
}

function revisionPath(path: string, hash: string) {
  return `${workspacePaths(dirname(path)).canonicalDir}/revisions/${hash}.glb`;
}

async function fileExists(path: string) {
  try {
    await Deno.stat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

async function retain(path: string, hash: string, bytes: Uint8Array): Promise<void> {
  if (await sha256Bytes(bytes) !== hash) {
    throw new Error(`Canonical asset hash mismatch at "${path}"; nothing was committed.`);
  }
  const revision = revisionPath(path, hash);
  if (await fileExists(revision)) {
    if (await sha256Bytes(await Deno.readFile(revision)) !== hash) {
      throw new Error(`Corrupt asset revision "${revision}"`);
    }
    return;
  }
  await Deno.mkdir(dirname(revision), { recursive: true });
  await writeAtomic(revision, bytes);
}

async function prepareAssets(
  path: string,
  before: CharacterManifest,
  after: State,
  source?: string,
) {
  const canonical = workspacePaths(dirname(path)).canonicalModel;
  const current = before.canonicalMesh?.gltfSha256;
  let managed = source !== undefined;
  if (current && await fileExists(canonical)) {
    await retain(path, current, await Deno.readFile(canonical));
    managed = true;
  }
  const next = after.doc.canonicalMesh?.gltfSha256;
  if (source) {
    if (!next) throw new Error('A canonical asset requires its manifest hash.');
    await retain(path, next, await Deno.readFile(source));
  }
  if (next && await fileExists(revisionPath(path, next))) {
    await retain(path, next, await Deno.readFile(revisionPath(path, next)));
    managed = true;
  }
  if (!managed) return;
  if (next && !(await fileExists(revisionPath(path, next)))) {
    // Legacy picks may still have their exact bytes; transformed history cannot be invented.
    const result = after.doc.generation.results.find((r) => r.output.gltfSha256 === next);
    const original = result ? resultPaths(dirname(path), result.id).model : undefined;
    if (!original || !(await fileExists(original))) {
      throw new Error(
        `Historical canonical revision ${next} is unavailable; nothing was committed.`,
      );
    }
    await retain(path, next, await Deno.readFile(original));
  }
  after.assetHash = next ?? null;
}

async function stateOf(path: string): Promise<State> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    throw new Error(
      `No character manifest at "${path}" - that directory is not a SpriteBook workspace.`,
    );
  }
  const patches = (await optionalText(`${path}.journal.ndjson`, '')).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line));
  return validateState({
    doc: JSON.parse(text),
    patches,
    cursor: Number((await optionalText(`${path}.journal.cursor`, String(patches.length))).trim()),
  }, path);
}

async function materialize(path: string, state: State): Promise<void> {
  const canonical = workspacePaths(dirname(path)).canonicalModel;
  if (state.assetHash) {
    const bytes = await Deno.readFile(revisionPath(path, state.assetHash));
    if (await sha256Bytes(bytes) !== state.assetHash) {
      throw new Error('Corrupt canonical revision; recovery refused.');
    }
    await writeAtomic(canonical, bytes);
  } else if (state.assetHash === null && await fileExists(canonical)) {
    await Deno.remove(canonical);
  }
  await writeAtomic(`${path}.journal.ndjson`, state.patches.map(canonicalJson).join(''));
  await writeAtomic(`${path}.journal.cursor`, String(state.cursor));
  await writeAtomic(path, canonicalJson(state.doc));
}

async function recover(path: string): Promise<void> {
  const pending = await optionalText(`${path}.pending.json`, '');
  if (!pending) return;
  const raw = JSON.parse(pending);
  if (raw.version !== 1) throw new Error(`Unsupported pending transaction at "${path}"`);
  const state = validateState(raw, path);
  await materialize(path, state);
  await Deno.remove(`${path}.pending.json`);
}

async function persist(path: string, state: State): Promise<void> {
  // This atomic intent is the commit point. Every reader rolls it forward under the same lock.
  await writeAtomic(`${path}.pending.json`, canonicalJson({ version: 1, ...state }));
  await recover(path);
}

export async function readManifest(path: string): Promise<CharacterManifest> {
  return await withManifestLock(path, async () => {
    await recover(path);
    return (await stateOf(path)).doc;
  });
}

export async function initializeManifest(
  path: string,
  doc: CharacterManifest,
  patches: ManifestPatch[] = [],
): Promise<void> {
  await withManifestWrite(path, () =>
    withManifestLock(path, async () => {
      await recover(path);
      if (await optionalText(path, '')) {
        throw new Error(`A character already exists at "${path}" - refusing to overwrite it.`);
      }
      await persist(path, validateState({ doc, patches, cursor: patches.length }, path));
    }));
}

export async function commitManifest(
  path: string,
  build: (manifest: CharacterManifest) => { op: JsonPatchOp[]; label: string },
  now?: () => string,
  canonicalSource?: string,
): Promise<CharacterManifest> {
  return await withManifestWrite(path, () =>
    withManifestLock(path, async () => {
      await recover(path);
      const state = await stateOf(path);
      const { op, label } = build(state.doc);
      if (!op.length) return state.doc;
      const kept = state.patches.slice(0, state.cursor);
      const journal = new ManifestJournal(state.doc, { now });
      const built = journal.commit({ target: { kind: 'character', id: state.doc.id }, op, label });
      const patch = { ...built, seq: kept.length ? kept.at(-1)!.seq + 1 : 0 };
      const next = validateState({
        doc: journal.doc as CharacterManifest,
        patches: [...kept, patch],
        cursor: kept.length + 1,
      }, path);
      await prepareAssets(path, state.doc, next, canonicalSource);
      await persist(path, next);
      return next.doc;
    }));
}

export async function moveManifestCursor(path: string, direction: 'undo' | 'redo') {
  return await withManifestWrite(path, () =>
    withManifestLock(path, async () => {
      await recover(path);
      const state = await stateOf(path);
      const index = direction === 'undo' ? state.cursor - 1 : state.cursor;
      if (index < 0 || index >= state.patches.length) {
        throw Object.assign(new Error(`Nothing to ${direction}`), {
          code: `nothing-to-${direction}`,
        });
      }
      const patch = state.patches[index];
      const doc = applyPatchOps(state.doc, direction === 'undo' ? patch.inverse : patch.op);
      let next: State;
      try {
        next = validateState({
          ...state,
          doc: doc as CharacterManifest,
          cursor: state.cursor + (direction === 'undo' ? -1 : 1),
        }, path);
      } catch (e) {
        throw Object.assign(
          new Error(
            `Cannot ${direction} "${patch.label}" at "${path}": ${
              e instanceof Error ? e.message : e
            }`,
          ),
          { code: 'invalid-manifest' },
        );
      }
      await prepareAssets(path, state.doc, next);
      await persist(path, next);
      return patch;
    }));
}
