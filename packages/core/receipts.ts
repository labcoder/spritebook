/**
 * Generation receipts (P3-T2): every change a generation run makes to a
 * CharacterManifest, expressed as a journaled ManifestPatch.
 *
 * Nothing here rewrites the manifest directly. Law 7 says every mutation is a
 * journaled, reversible patch, and `spritebook undo`/`redo` already read the
 * three files this module writes — so generation becomes undoable for free,
 * and a raw file rewrite would be a hole in the undo stack rather than a
 * shortcut.
 *
 * ## The on-disk journal (the CLI owns this contract)
 *
 *   <manifest>                    the current document, canonical bytes
 *   <manifest>.journal.ndjson     append-only ManifestPatch lines
 *   <manifest>.journal.cursor     how many of those patches are applied
 *
 * A commit made while the cursor sits behind the end of the journal drops the
 * redo tail, exactly as `ManifestJournal.commit` clears its redo stack in
 * memory: the undone future is not reachable any more, and leaving those lines
 * on disk would let `redo` replay a patch computed against a document that no
 * longer exists.
 *
 * ## Write order is a crash-safety argument
 *
 * journal -> cursor -> manifest. A crash between the cursor and the manifest
 * leaves a cursor claiming a patch that the document has not received, and
 * `undo` then replays that patch's inverse against the older document: for a
 * replace that restores the value already there (self-healing), and for an
 * append it fails loudly on an out-of-range index. The other order is worse —
 * an understated cursor makes `undo` replay the WRONG patch's inverse and
 * silently corrupt the manifest. Loud beats silent.
 *
 * ## Where canonicalMesh's non-mesh facts come from
 *
 * A GenerationResult pins `output.gltfSha256` and nothing else that
 * `canonicalMesh` needs: `heightM` is a job-time input (GenJobSpec's
 * `declaredHeightM`) and `texturedBy` is decided by the backend's registry
 * entry (the texture substage runs only when `outputs.texture === false`).
 * `pickResult` therefore takes both as options and carries forward whatever a
 * previous pick recorded. Neither is ever invented — a fabricated height is a
 * provenance lie, so a first pick with no height refuses.
 */
import type {
  CharacterManifest,
  GenerationResult,
  JsonPatchOp,
  ManifestPatch,
} from '@spritebook/schema';
import {
  canonicalJson,
  CharacterManifestSchema,
  GenerationResultSchema,
  ManifestPatchSchema,
  parseWith,
} from '@spritebook/schema';
import { ManifestJournal } from './journal.ts';
import { type WorkspacePaths, workspacePaths } from './workspace.ts';

export interface ReceiptOptions {
  /** overrides the default undo-stack label */
  label?: string;
  now?: () => string;
}

export interface PickOptions extends ReceiptOptions {
  /** required on a first pick; otherwise carried forward from the last one */
  heightM?: number;
  /** required on a first pick; otherwise carried forward from the last one */
  texturedBy?: 'backend' | 'texture-substage';
  /** a freshly picked mesh has not been reprojected yet (default false) */
  reprojected?: boolean;
}

export interface CanonicalMeshPatch {
  gltfSha256?: string;
  heightM?: number;
  texturedBy?: 'backend' | 'texture-substage';
  reprojected?: boolean;
}

/**
 * Append a generation receipt. The label reads like history because it lands
 * in the undo stack a human scrolls: "Generate r2 (trellis2-4b)".
 */
export async function appendGenerationResult(
  workspace: string,
  result: GenerationResult,
  opts: ReceiptOptions = {},
): Promise<CharacterManifest> {
  const valid = parseWith(GenerationResultSchema, result, 'GenerationResult');
  return await commit(workspace, (manifest) => {
    if (manifest.generation.results.some((r) => r.id === valid.id)) {
      throw new Error(
        `Result "${valid.id}" is already recorded for this character - result ids are never ` +
          `reused, and nextResultId() returns the next free one.`,
      );
    }
    return {
      op: [{ op: 'add', path: '/generation/results/-', value: valid }],
      label: opts.label ?? `Generate ${valid.id} (${valid.backend.modelId})`,
    };
  }, opts.now);
}

/**
 * Pick a result as the character's canonical mesh: sets `pickedResultId` and
 * writes `canonicalMesh` from that receipt's canonical model.
 */
export async function pickResult(
  workspace: string,
  resultId: string,
  opts: PickOptions = {},
): Promise<CharacterManifest> {
  return await commit(workspace, (manifest) => {
    const result = requireResult(manifest, resultId);
    if (result.discarded) {
      throw new Error(
        `Result "${resultId}" was discarded, so it cannot be picked - ${
          describeAvailable(manifest)
        }`,
      );
    }
    const current = manifest.canonicalMesh;
    const heightM = opts.heightM ?? current?.heightM;
    if (heightM === undefined) {
      throw new Error(
        `Picking "${resultId}" needs a standing height: pass heightM (the same value the ` +
          `generation job declared) - it cannot be read back from the mesh receipt.`,
      );
    }
    const texturedBy = opts.texturedBy ?? current?.texturedBy;
    if (texturedBy === undefined) {
      throw new Error(
        `Picking "${resultId}" needs texturedBy ('backend' or 'texture-substage') - which one ` +
          `ran is a property of the generation job, not of the receipt.`,
      );
    }
    const canonicalMesh = {
      gltfSha256: result.output.gltfSha256,
      heightM,
      texturedBy,
      reprojected: opts.reprojected ?? false,
    };
    return {
      op: [
        setOp('/generation/pickedResultId', resultId, manifest.generation.pickedResultId),
        setOp('/canonicalMesh', canonicalMesh, current),
      ],
      label: opts.label ?? `Pick ${resultId}`,
    };
  }, opts.now);
}

/**
 * Mark a receipt discarded. The files stay and the id stays: receipts are
 * append-only history, not a live set, so "discarded" is a flag rather than a
 * deletion.
 */
export async function discardResult(
  workspace: string,
  resultId: string,
  opts: ReceiptOptions = {},
): Promise<CharacterManifest> {
  return await commit(workspace, (manifest) => {
    const result = requireResult(manifest, resultId);
    if (manifest.generation.pickedResultId === resultId) {
      throw new Error(
        `Result "${resultId}" is the one this character is currently built from - pick another ` +
          `result first, then discard it.`,
      );
    }
    if (result.discarded) throw new Error(`Result "${resultId}" is already discarded.`);
    const index = manifest.generation.results.indexOf(result);
    return {
      op: [{ op: 'replace', path: `/generation/results/${index}/discarded`, value: true }],
      label: opts.label ?? `Discard ${resultId}`,
    };
  }, opts.now);
}

/**
 * Update the canonical mesh in place — the seam `pick --reproject` uses to
 * flip `reprojected` and pin the new hash once reprojection has run.
 */
export async function setCanonicalMesh(
  workspace: string,
  fields: CanonicalMeshPatch,
  opts: ReceiptOptions = {},
): Promise<CharacterManifest> {
  return await commit(workspace, (manifest) => {
    const current = manifest.canonicalMesh;
    if (!current) {
      throw new Error(
        `This character has no canonical mesh yet - pick a generation result first; that is ` +
          `what writes the first one.`,
      );
    }
    // undefined entries must not survive the spread: they would erase a
    // required field on the way through JSON
    const next = { ...current, ...defined(fields) };
    if (canonicalJson(next) === canonicalJson(current)) {
      throw new Error('setCanonicalMesh was given nothing to change.');
    }
    return {
      op: [{ op: 'replace', path: '/canonicalMesh', value: next }],
      label: opts.label ??
        (fields.reprojected === true ? 'Reproject canonical mesh' : 'Update canonical mesh'),
    };
  }, opts.now);
}

// ---------------------------------------------------------------------------
// The journaled read-modify-write
// ---------------------------------------------------------------------------

interface JournalState {
  doc: Record<string, unknown>;
  patches: ManifestPatch[];
  cursor: number;
}

/** Mirrors `readJournal` in packages/cli/mod.ts — same files, same checks. */
async function readJournalState(paths: WorkspacePaths): Promise<JournalState> {
  let text: string;
  try {
    text = await Deno.readTextFile(paths.manifest);
  } catch {
    throw new Error(
      `No character manifest at "${paths.manifest}" - that directory is not a SpriteBook ` +
        `workspace.`,
    );
  }
  const doc = JSON.parse(text) as Record<string, unknown>;
  const journalText = await Deno.readTextFile(paths.journal).catch(() => '');
  const patches = journalText
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l, i) => parseWith(ManifestPatchSchema, JSON.parse(l), `journal line ${i + 1}`));
  const cursorText = await Deno.readTextFile(paths.cursor).catch(() => String(patches.length));
  const cursor = Number(cursorText.trim());
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > patches.length) {
    throw new Error(
      `corrupt cursor file "${paths.cursor}": "${cursorText.trim()}" (journal has ` +
        `${patches.length} patches)`,
    );
  }
  return { doc, patches, cursor };
}

/**
 * Read the manifest, let `build` turn it into ops, journal the patch with its
 * precomputed inverse, and persist all three files.
 *
 * `build` throws for a refusal, which is why it runs before anything is
 * written: an unknown result id must cost nothing.
 */
async function commit(
  workspace: string,
  build: (manifest: CharacterManifest) => { op: JsonPatchOp[]; label: string },
  now?: () => string,
): Promise<CharacterManifest> {
  const paths = workspacePaths(workspace);
  const state = await readJournalState(paths);
  const current = parseWith(
    CharacterManifestSchema,
    state.doc,
    `CharacterManifest at "${paths.manifest}"`,
  );
  const { op, label } = build(current);

  const kept = state.patches.slice(0, state.cursor);
  const journal = new ManifestJournal(state.doc, { now });
  const built = journal.commit({ target: { kind: 'character', id: current.id }, op, label });
  // ManifestJournal numbers from zero per instance; the file is the whole
  // history of the workspace, so the sequence continues from the last line.
  const patch = parseWith(ManifestPatchSchema, {
    ...built,
    seq: kept.length === 0 ? 0 : kept[kept.length - 1].seq + 1,
  }, 'ManifestPatch');
  const next = parseWith(
    CharacterManifestSchema,
    journal.doc,
    `patched CharacterManifest ("${label}")`,
  );

  const journalBytes = [...kept, patch].map((p) => canonicalJson(p)).join('');
  await writeAtomic(paths.journal, journalBytes);
  await writeAtomic(paths.cursor, String(kept.length + 1));
  await writeAtomic(paths.manifest, journal.canonicalBytes);
  return next;
}

/** Write via a sibling temp file so a reader never sees a half-written doc. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, text);
  await Deno.rename(tmp, path);
}

/**
 * `add` when the key is absent, `replace` when it is present — the two are not
 * interchangeable here: the inverse of an `add` is a `remove`, which would
 * delete a field that undo was supposed to restore.
 */
function setOp(path: string, value: unknown, existing: unknown): JsonPatchOp {
  return existing === undefined ? { op: 'add', path, value } : { op: 'replace', path, value };
}

function requireResult(manifest: CharacterManifest, resultId: string): GenerationResult {
  const found = manifest.generation.results.find((r) => r.id === resultId);
  if (found) return found;
  throw new Error(
    `No generation result "${resultId}" in this character - ${describeAvailable(manifest)}`,
  );
}

function describeAvailable(manifest: CharacterManifest): string {
  const usable = manifest.generation.results.filter((r) => !r.discarded).map((r) => r.id);
  if (usable.length > 0) return `available: ${usable.join(', ')}.`;
  return manifest.generation.results.length === 0
    ? 'nothing has been generated for this character yet.'
    : 'every result so far has been discarded, so generate another one.';
}

function defined<T extends object>(fields: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
