/**
 * Roster operations: `clone` and `rename` (P3-T4).
 *
 * Both exist because of the identity law (D-011): a character's `id` is
 * immutable and every cache key binds to it, while `displayName` is free to
 * change. That split is what makes these two verbs cheap and safe —
 *
 *   rename  touches ONE field, invalidates NOTHING (proven since P1 in
 *           core/cache_test.ts: the cache key never sees the display name)
 *   clone   mints a NEW id, because a copy that shared an id would share
 *           cache entries and bake results, and the moment the copy diverged
 *           one of them would be serving the other's pixels
 *
 * The cost of that correctness, stated plainly: a fresh clone re-bakes from
 * scratch even though its inputs are byte-identical to its source, because
 * `characterId` is part of every cache key. Sharing them would need the key to
 * drop the id, which is exactly what D-011 refuses. Recorded rather than
 * quietly optimized.
 */
import type { CharacterId, CharacterManifest } from '@spritebook/schema';
import {
  canonicalJson,
  CharacterIdSchema,
  CharacterManifestSchema,
  MANIFEST_FILE,
  ManifestPatchSchema,
  migrateCharacterManifest,
  parseWith,
} from '@spritebook/schema';
import { ManifestJournal } from './journal.ts';
import { readWorkspace, workspacePaths } from './workspace.ts';

export interface RosterOptions {
  now?: () => string;
  label?: string;
}

/**
 * Rename a character. One field, one patch, zero invalidation — the display
 * name is not an input to anything that gets cached.
 */
export async function renameCharacter(
  workspace: string,
  displayName: string,
  opts: RosterOptions = {},
): Promise<CharacterManifest> {
  if (displayName.trim().length === 0) {
    throw new Error('rename: the new name cannot be empty');
  }
  const paths = workspacePaths(workspace);
  const current = await readWorkspace(workspace);
  if (current.displayName === displayName) {
    throw new Error(`This character is already called "${displayName}".`);
  }

  const now = opts.now;
  const state = await readJournalState(paths);
  const kept = state.patches.slice(0, state.cursor);
  const journal = new ManifestJournal(state.doc, { now });
  const built = journal.commit({
    target: { kind: 'character', id: current.id },
    op: [{ op: 'replace', path: '/displayName', value: displayName }],
    label: opts.label ?? `Rename to "${displayName}"`,
  });
  const patch = parseWith(ManifestPatchSchema, {
    ...built,
    seq: kept.length === 0 ? 0 : kept[kept.length - 1].seq + 1,
  }, 'ManifestPatch');
  const next = parseWith(CharacterManifestSchema, journal.doc, 'renamed CharacterManifest');

  await Deno.writeTextFile(paths.journal, [...kept, patch].map((p) => canonicalJson(p)).join(''));
  await Deno.writeTextFile(paths.cursor, String(kept.length + 1));
  await Deno.writeTextFile(paths.manifest, journal.canonicalBytes);
  return next;
}

export interface CloneOptions extends RosterOptions {
  /** the new character's immutable id */
  id: string;
  /** defaults to "<source name> copy" */
  displayName?: string;
}

/**
 * Copy a character into a new workspace under a NEW id.
 *
 * Everything the source produced comes along — its source image, generation
 * results and receipts, canonical mesh, rig — because a clone the user has to
 * re-generate is not a clone. What does NOT come along is `lastBakeId`: that
 * names a bake belonging to the source's identity, and the copy has not baked
 * anything yet. Claiming otherwise would point a fresh character at another
 * character's atlas.
 *
 * The clone's journal starts fresh, with its first entry naming where it came
 * from — history a human reading the undo stack can follow.
 */
export async function cloneCharacter(
  sourceWorkspace: string,
  destWorkspace: string,
  opts: CloneOptions,
): Promise<CharacterManifest> {
  const source = await readWorkspace(sourceWorkspace);
  const id = parseWith(CharacterIdSchema, opts.id, 'clone --id');
  if (id === source.id) {
    throw new Error(
      `A clone needs a NEW id: "${id}" is the source's own, and two characters sharing an id ` +
        `would share cache entries and bake results.`,
    );
  }
  const destPaths = workspacePaths(destWorkspace);
  if (await exists(destPaths.manifest)) {
    throw new Error(
      `"${destPaths.manifest}" already exists - clone never overwrites a character; ` +
        `pick another destination or remove that one first.`,
    );
  }

  await copyTree(
    sourceWorkspace,
    destWorkspace,
    new Set([
      MANIFEST_FILE,
      `${MANIFEST_FILE}.journal.ndjson`,
      `${MANIFEST_FILE}.journal.cursor`,
    ]),
  );

  const now = opts.now ?? (() => new Date().toISOString());
  const cloned: CharacterManifest = {
    ...source,
    id: id as CharacterId,
    displayName: opts.displayName ?? `${source.displayName} copy`,
    createdAt: now(),
  };
  // the copy has baked nothing; that id belongs to the source's identity
  delete (cloned as { lastBakeId?: string }).lastBakeId;
  const validated = parseWith(CharacterManifestSchema, cloned, 'cloned CharacterManifest');

  await Deno.mkdir(destWorkspace, { recursive: true });
  await Deno.writeTextFile(destPaths.manifest, canonicalJson(validated));
  // a fresh history, whose first line says where this character came from
  const journal = new ManifestJournal(JSON.parse(canonicalJson(validated)), { now: opts.now });
  const built = journal.commit({
    target: { kind: 'character', id: validated.id },
    op: [{ op: 'replace', path: '/displayName', value: validated.displayName }],
    label: opts.label ?? `Clone of ${source.id} ("${source.displayName}")`,
  });
  const patch = parseWith(ManifestPatchSchema, { ...built, seq: 0 }, 'ManifestPatch');
  await Deno.writeTextFile(destPaths.journal, canonicalJson(patch));
  await Deno.writeTextFile(destPaths.cursor, '1');
  await Deno.writeTextFile(destPaths.manifest, journal.canonicalBytes);
  return parseWith(CharacterManifestSchema, journal.doc, 'cloned CharacterManifest');
}

// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Recursive copy, skipping the manifest/journal files the caller rewrites. */
async function copyTree(from: string, to: string, skipTop: Set<string>): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (skipTop.has(entry.name)) continue;
    const src = `${from}/${entry.name}`;
    const dst = `${to}/${entry.name}`;
    if (entry.isDirectory) {
      await copyTree(src, dst, new Set());
    } else if (entry.isFile) {
      await Deno.copyFile(src, dst);
    }
    // symlinks are deliberately not followed: a character that references
    // files outside its own workspace is not self-contained, and silently
    // materializing them here would hide that
  }
}

async function readJournalState(paths: { manifest: string; journal: string; cursor: string }) {
  // migrated at the read, for the reason receipts.ts's copy of this spells out:
  // `doc` becomes the ManifestJournal, and journal.canonicalBytes is written
  const doc = migrateCharacterManifest(JSON.parse(await Deno.readTextFile(paths.manifest)));
  const text = await Deno.readTextFile(paths.journal).catch(() => '');
  const patches = text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l, i) => parseWith(ManifestPatchSchema, JSON.parse(l), `journal line ${i + 1}`));
  const cursorText = await Deno.readTextFile(paths.cursor).catch(() => String(patches.length));
  const cursor = Number(cursorText.trim());
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > patches.length) {
    throw new Error(`corrupt cursor file: "${cursorText.trim()}" (journal has ${patches.length})`);
  }
  return { doc, patches, cursor };
}
