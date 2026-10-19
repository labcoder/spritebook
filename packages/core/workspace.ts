/**
 * The character workspace (P3-T2): the on-disk home of one character — its
 * manifest, its journal, the source image, and every generation result. The
 * layout is frozen in `@spritebook/schema/gen.ts`; this module is the only
 * place that turns those constants into paths, so nothing downstream ever
 * re-spells `results/` or `model.glb`.
 *
 *   <workspace>/
 *     character.json                  CharacterManifest, canonical bytes
 *     character.json.journal.ndjson   the P1-T3 journal — `spritebook undo`
 *     character.json.journal.cursor   already drives these two files
 *     source/<sha256><ext>            the source image, content-addressed
 *     results/<resultId>/{raw.glb,model.glb,preflight.json}
 *     canonical/model.glb             a copy of the PICKED result
 *     bakes/bake-<bakeId>/            where `bake --workspace` lands (D-029)
 *
 * ## Why creation writes a journal it has nothing to say in
 *
 * `createWorkspace` lays down an EMPTY journal and a cursor of 0 rather than
 * leaving both absent. The CLI tolerates missing files (it defaults the cursor
 * to the patch count), but a workspace whose journal exists from birth can be
 * appended to by `receipts.ts` without either side owning "create it if it is
 * the first mutation" — the file's existence stops being a state to reason
 * about.
 *
 * ## Result ids are monotonic, not dense
 *
 * `nextResultId` returns max(existing) + 1 over EVERY receipt, discarded ones
 * included. Receipts are append-only history: a discarded r1 keeps its id and
 * its files forever, so reusing that id would silently repoint provenance that
 * an old bake manifest still refers to.
 */
import type { CharacterManifest } from '@spritebook/schema';
import {
  BAKES_DIR,
  CANONICAL_DIR,
  CANONICAL_MODEL,
  CHARACTER_SCHEMA_VERSION,
  CharacterIdSchema,
  CharacterManifestSchema,
  MANIFEST_FILE,
  parseWith,
  RAW_MODEL,
  RESULT_PREFLIGHT,
  ResultIdSchema,
  RESULTS_DIR,
  SOURCE_DIR,
} from '@spritebook/schema';

import { initializeManifest, readManifest } from './persistence.ts';

/** `r1`, `r2`, ... — creation order, never reused (ResultIdSchema). */
export type ResultId = string;

export interface WorkspacePaths {
  /** the CharacterManifest, always canonical bytes */
  manifest: string;
  /** append-only ManifestPatch lines */
  journal: string;
  /** how many patches are currently applied */
  cursor: string;
  sourceDir: string;
  resultsDir: string;
  canonicalDir: string;
  /** the picked result, copied so downstream verbs have one stable path */
  canonicalModel: string;
  /** outRoot for `bake --workspace`; each bake is `bake-<bakeId>` inside it */
  bakesDir: string;
}

export interface ResultPaths {
  dir: string;
  /** what the backend emitted, kept because a backend bug and a border bug
   * look identical from the canonical side alone */
  raw: string;
  /** canonical glb — the receipt's `output.gltfSha256` pins THIS */
  model: string;
  preflight: string;
}

/**
 * Every path in a workspace, derived from the frozen constants.
 *
 * `characterId` never appears in a path (the workspace dir IS the character
 * dir, per the frozen layout); passing it validates that the caller's id is a
 * legal CharacterId before any directory gets created under it.
 */
export function workspacePaths(workspace: string, characterId?: string): WorkspacePaths {
  if (characterId !== undefined) parseWith(CharacterIdSchema, characterId, 'characterId');
  const root = workspace.replace(/[\\/]+$/, '');
  const manifest = `${root}/${MANIFEST_FILE}`;
  return {
    manifest,
    // these two suffixes are the CLI's on-disk journal contract (see the
    // `files()` helper in packages/cli/mod.ts) — they must stay in lockstep
    journal: `${manifest}.journal.ndjson`,
    cursor: `${manifest}.journal.cursor`,
    sourceDir: `${root}/${SOURCE_DIR}`,
    resultsDir: `${root}/${RESULTS_DIR}`,
    canonicalDir: `${root}/${CANONICAL_DIR}`,
    canonicalModel: `${root}/${CANONICAL_DIR}/${CANONICAL_MODEL}`,
    bakesDir: `${root}/${BAKES_DIR}`,
  };
}

/** Where one generation attempt's three artifacts live. */
export function resultPaths(workspace: string, resultId: string): ResultPaths {
  const id = parseWith(ResultIdSchema, resultId, 'resultId');
  const dir = `${workspacePaths(workspace).resultsDir}/${id}`;
  return {
    dir,
    raw: `${dir}/${RAW_MODEL}`,
    model: `${dir}/${CANONICAL_MODEL}`,
    preflight: `${dir}/${RESULT_PREFLIGHT}`,
  };
}

export interface CreateWorkspaceOptions {
  workspace: string;
  characterId: string;
  displayName: string;
  source: {
    kind: 'image' | 'mesh';
    originalFilename: string;
    sha256: string;
  };
  now?: () => string;
}

/**
 * Create a workspace: the directories, an initial manifest as canonical bytes,
 * and an empty journal the CLI's undo/redo can drive immediately.
 *
 * The manifest is written LAST because it is the existence marker this
 * function refuses on — a crash halfway through leaves a directory a retry can
 * finish rather than a half-built workspace that can never be created again.
 */
export async function createWorkspace(opts: CreateWorkspaceOptions): Promise<CharacterManifest> {
  const paths = workspacePaths(opts.workspace, opts.characterId);
  if (await pathExists(paths.manifest)) {
    throw new Error(
      `A character already exists at "${paths.manifest}" - refusing to overwrite it. ` +
        `Use a different workspace directory, or delete that one first.`,
    );
  }
  const now = opts.now ?? (() => new Date().toISOString());
  // every optional field is left OUT rather than stubbed: nothing has been
  // generated, picked, rigged or baked yet, and an empty stub would read as a
  // claim that it had
  const manifest = parseWith(CharacterManifestSchema, {
    schemaVersion: CHARACTER_SCHEMA_VERSION,
    id: opts.characterId,
    displayName: opts.displayName,
    createdAt: now(),
    source: {
      kind: opts.source.kind,
      originalFilename: opts.source.originalFilename,
      sha256: opts.source.sha256,
    },
    generation: { results: [] },
    // D-008: asymmetry is first-class, so mirroring is opt-in
    mirroring: { enabled: false },
  }, `initial CharacterManifest for "${opts.characterId}"`);

  await Deno.mkdir(paths.sourceDir, { recursive: true });
  await Deno.mkdir(paths.resultsDir, { recursive: true });
  await Deno.mkdir(paths.canonicalDir, { recursive: true });
  await initializeManifest(paths.manifest, manifest);
  return manifest;
}

/** Read and validate the manifest; errors name the path that disappointed. */
export async function readWorkspace(workspace: string): Promise<CharacterManifest> {
  return await readManifest(workspacePaths(workspace).manifest);
}

export interface StoredSource {
  sha256: string;
  storedPath: string;
  /** the name the user chose, kept for display — the stored name is a hash */
  originalFilename: string;
}

/**
 * Copy a source image into `source/<sha256><ext>`.
 *
 * Content-addressed, so re-importing the same bytes is a no-op: the path is a
 * function of the content, and an existing file at that path already holds
 * exactly those bytes. Two different images therefore always land on two
 * paths, and the same image never rewrites the file it already occupies.
 */
export async function storeSourceImage(
  workspace: string,
  imagePath: string,
): Promise<StoredSource> {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(imagePath);
  } catch {
    throw new Error(`Cannot read the source image at "${imagePath}" - does that file exist?`);
  }
  const sha256 = await sha256OfBytes(bytes);
  const originalFilename = baseName(imagePath);
  const { sourceDir } = workspacePaths(workspace);
  const storedPath = `${sourceDir}/${sha256}${extName(originalFilename)}`;
  await Deno.mkdir(sourceDir, { recursive: true });
  if (!(await pathExists(storedPath))) await Deno.writeFile(storedPath, bytes);
  return { sha256, storedPath, originalFilename };
}

/**
 * The next free result id: max(existing) + 1 across every receipt, discarded
 * ones included, so an id is never handed out twice in one character's life.
 */
export function nextResultId(manifest: CharacterManifest): ResultId {
  let max = 0;
  for (const result of manifest.generation.results) {
    const match = /^r([1-9][0-9]*)$/.exec(result.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `r${max + 1}`;
}

// ---------------------------------------------------------------------------
// Small local helpers — deliberately not a path library: the layout is all
// forward slashes by contract, and these two cases are the whole need.
// ---------------------------------------------------------------------------

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0 ? path : path.slice(cut + 1);
}

/** '.png' for 'hero.png'; '' for 'hero' and for dotfiles like '.gitignore'. */
function extName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/**
 * Where `storeSourceImage` put this manifest's source image.
 *
 * Exported because callers kept re-deriving it: `pick --reproject` and the
 * CLI's `--more-like` both need the stored source back, and both got it
 * subtly wrong for a filename with no extension (`slice(lastIndexOf('.'))`
 * returns the last CHARACTER when there is no dot, so `cutout` resolved to
 * `<sha>t`). One derivation, one place, no drift.
 */
export function sourceImagePath(workspace: string, manifest: CharacterManifest): string {
  const { sourceDir } = workspacePaths(workspace);
  return `${sourceDir}/${manifest.source.sha256}${extName(manifest.source.originalFilename)}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
