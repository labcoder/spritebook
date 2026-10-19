import { relative, resolve } from 'node:path';
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
import type {
  CharacterId,
  CharacterManifest,
  RosterEntry,
  RosterManifest,
} from '@spritebook/schema';
import {
  BakeManifestSchema,
  canonicalJson,
  CharacterIdSchema,
  CharacterManifestSchema,
  MANIFEST_FILE,
  parseWith,
  ROSTER_FILE,
  RosterManifestSchema,
  SCHEMA_VERSION,
} from '@spritebook/schema';
import { ManifestJournal } from './journal.ts';
import {
  commitManifest,
  initializeManifest,
  withManifestWrite,
  writeAtomic,
} from './persistence.ts';
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
  return await commitManifest(workspacePaths(workspace).manifest, (current) => {
    if (current.displayName === displayName) {
      throw new Error(`This character is already called "${displayName}".`);
    }
    return {
      op: [{ op: 'replace', path: '/displayName', value: displayName }],
      label: opts.label ?? `Rename to "${displayName}"`,
    };
  }, opts.now);
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
) {
  const nested = relative(resolve(sourceWorkspace), resolve(destWorkspace));
  if (!nested || (!nested.startsWith('..') && !nested.includes(':'))) {
    throw new Error('Clone destination must be outside the source workspace');
  }
  await Deno.mkdir(destWorkspace, { recursive: true });
  const paths = [workspacePaths(sourceWorkspace).manifest, workspacePaths(destWorkspace).manifest]
    .sort();
  return await withManifestWrite(
    paths[0],
    () =>
      withManifestWrite(
        paths[1],
        () => cloneUnlocked(sourceWorkspace, destWorkspace, opts),
      ),
  );
}

async function cloneUnlocked(
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
      `${MANIFEST_FILE}.lock`,
      `${MANIFEST_FILE}.job.lock`,
      `${MANIFEST_FILE}.pending.json`,
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

  // A fresh history whose first line says where this character came from — and
  // whose first line is TRUE. It used to journal `replace /displayName` to the
  // value the document already held, so `undo` on a fresh clone reported
  // "undid: Clone of knight" and changed nothing; an undo that visibly does
  // nothing is how a user stops trusting the stack. The journal's base is
  // therefore the copy BEFORE its rename, which makes the patch a real change:
  // undo takes the copy back to the source's name, which is a thing someone
  // who did not want the " copy" suffix would actually ask for.
  const renamed = validated.displayName !== source.displayName;
  const base = { ...validated, displayName: source.displayName };
  const journal = new ManifestJournal(JSON.parse(canonicalJson(base)), { now: opts.now });
  const patches = [];
  if (renamed) {
    patches.push(journal.commit({
      target: { kind: 'character', id: validated.id },
      op: [{ op: 'replace', path: '/displayName', value: validated.displayName }],
      label: opts.label ?? `Clone of ${source.id} ("${source.displayName}")`,
    }));
  }
  await initializeManifest(destPaths.manifest, journal.doc as CharacterManifest, patches);
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

// ---------------------------------------------------------------------------
// The roster scan (P4-T3)
// ---------------------------------------------------------------------------

/**
 * Every character under a root, as plain data.
 *
 * DERIVED, always. The scan reads the character.json files and rebuilds the
 * index from scratch; `roster.json` is written for the user and the GUI to
 * read, and this function never reads it back. That is deliberate — an index
 * that were consulted as truth would be a second place a character's id and
 * name live, and the first stale one silently bakes the wrong thing.
 *
 * A directory whose character.json exists but cannot be read or parsed lands
 * in `unreadable` rather than being skipped. A batch that quietly did 9 of 10
 * is precisely the failure this whole task exists to prevent, so the count the
 * user sees has to include the ones that went wrong.
 */
export interface ScanRosterOptions {
  now?: () => string;
  /** only characters whose manifest was written at or after this instant */
  changedSince?: Date;
}

export async function scanRoster(
  root: string,
  opts: ScanRosterOptions = {},
): Promise<RosterManifest> {
  const now = opts.now ?? (() => new Date().toISOString());
  const base = root.replace(/[\\/]+$/, '');
  const characters: RosterEntry[] = [];
  const unreadable: { dir: string; error: string }[] = [];

  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(base)];
  } catch (err) {
    throw new Error(
      `Cannot read the roster root "${base}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const dir = `${base}/${entry.name}`;
    const paths = workspacePaths(dir);
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(paths.manifest);
    } catch {
      continue; // not a workspace — roots hold other directories too, and that
      // is not an error the way an unparseable manifest is
    }
    // The mtime is what `--changed-since` compares. It answers "was this
    // TOUCHED", which is a different and much cheaper question than "would
    // its pixels differ" — see the plan for the second one. A rename touches
    // the manifest and invalidates nothing (D-011), so the two answers
    // legitimately disagree and both are worth having.
    const updatedAt = (stat.mtime ?? new Date(0)).toISOString();
    if (opts.changedSince && (stat.mtime ?? new Date(0)) < opts.changedSince) continue;

    let manifest: CharacterManifest;
    try {
      manifest = await readWorkspace(dir);
    } catch (err) {
      unreadable.push({ dir: entry.name, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    // `ready` asks the disk, not the manifest: a manifest can carry a
    // canonicalMesh record whose file was deleted underneath it, and finding
    // that out at frame 1 of an overnight run is the expensive way to learn it
    let ready = manifest.canonicalMesh !== undefined;
    if (ready) {
      try {
        await Deno.stat(paths.canonicalModel);
      } catch {
        ready = false;
      }
    }
    let lastBakedAt: string | undefined;
    if (manifest.lastBakeId !== undefined) {
      try {
        const baked = JSON.parse(
          await Deno.readTextFile(`${paths.bakesDir}/bake-${manifest.lastBakeId}/manifest.json`),
        );
        lastBakedAt = parseWith(BakeManifestSchema, baked, 'BakeManifest').createdAt;
      } catch {
        // the id points at a bake that is gone or unreadable; the plan will
        // call that never-baked, which is the honest and safe reading
      }
    }
    characters.push({
      id: manifest.id,
      dir: entry.name,
      displayName: manifest.displayName,
      updatedAt,
      ready,
      ...(manifest.lastBakeId !== undefined ? { lastBakeId: manifest.lastBakeId } : {}),
      ...(lastBakedAt !== undefined ? { lastBakedAt } : {}),
    });
  }

  // sorted so two scans of an unchanged root are byte-identical
  characters.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  unreadable.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return parseWith(RosterManifestSchema, {
    schemaVersion: SCHEMA_VERSION,
    root: base,
    scannedAt: now(),
    characters,
    unreadable,
  }, 'RosterManifest');
}

/** Write the scan to `<root>/roster.json`, canonically. Returns the path. */
export async function writeRosterManifest(roster: RosterManifest): Promise<string> {
  const path = `${roster.root}/${ROSTER_FILE}`;
  await writeAtomic(path, canonicalJson(roster));
  return path;
}
