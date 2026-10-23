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
 * Persistence is shared with rename/undo/redo in persistence.ts: an exclusive
 * OS lock and a write-ahead intent recover the manifest, journal and cursor.
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
  Attachment,
  CharacterManifest,
  ClipBinding,
  DetailLayer,
  GenerationResult,
  JsonPatchOp,
  RigState,
} from '@spritebook/schema';
import { canonicalJson, GenerationResultSchema, parseWith } from '@spritebook/schema';
import { commitManifest } from './persistence.ts';
import { workspacePaths } from './workspace.ts';

export interface ReceiptOptions {
  /** overrides the default undo-stack label */
  label?: string;
  now?: () => string;
  /** Staged GLB published with this patch, never before it. */
  canonicalSource?: string;
}

export interface PickOptions extends ReceiptOptions {
  /** required on a first pick; otherwise carried forward from the last one */
  heightM?: number;
  /** required on a first pick; otherwise carried forward from the last one */
  texturedBy?: 'backend' | 'texture-substage' | 'source';
  /** a freshly picked mesh has not been reprojected yet (default false) */
  reprojected?: boolean;
  /**
   * Canonical mesh fields the caller MEASURED off the bytes it just landed,
   * overriding what the receipt implies — the same seam `setRigState` opens
   * for a Track A fit, and for the same reason. `pick --reproject` repaints
   * the mesh before it becomes canonical, so the bytes on disk are not the
   * receipt's any more; their hash has to ride in THIS patch. Journaling the
   * re-pin separately means one `spritebook undo` restores the pre-reproject
   * sha while the file still holds reprojected bytes.
   */
  canonicalMesh?: CanonicalMeshPatch;
}

export interface CanonicalMeshPatch {
  gltfSha256?: string;
  heightM?: number;
  texturedBy?: 'backend' | 'texture-substage' | 'source';
  reprojected?: boolean;
  colorMatched?: boolean;
  /** the image the fidelity passes conditioned on (see the schema's docstring) */
  imageSha256?: string;
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
  }, opts);
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
      // what the caller measured wins over what the receipt implies: the
      // manifest must pin the bytes that are ACTUALLY canonical now
      ...defined(opts.canonicalMesh ?? {}),
    };
    return {
      op: [
        setOp('/generation/pickedResultId', resultId, manifest.generation.pickedResultId),
        setOp('/canonicalMesh', canonicalMesh, current),
      ],
      label: opts.label ?? `Pick ${resultId}`,
    };
  }, opts);
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
  }, opts);
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
  }, opts);
}

/**
 * Record the rig (P3-T3), as a journaled patch like everything else — which is
 * what makes `spritebook undo` work on a joint nudge for free. RigState is
 * replaced wholesale rather than merged: the rig is one coherent fact (this
 * skeleton, from this backend, with these repairs applied), and merging halves
 * of two different rigs would describe a character that never existed.
 */
export async function setRigState(
  workspace: string,
  rig: RigState,
  opts: ReceiptOptions & { canonicalMesh?: CanonicalMeshPatch } = {},
): Promise<CharacterManifest> {
  return await commit(workspace, (manifest) => {
    const current = manifest.rig;
    const sameRig = current !== undefined && canonicalJson(current) === canonicalJson(rig);
    if (sameRig && opts.canonicalMesh === undefined) {
      throw Object.assign(new Error('setRigState was given the rig the character already has.'), {
        code: 'rig-unchanged',
      });
    }
    // A Track A fit REPLACES the canonical mesh with the fitted body, so the
    // hash re-pin belongs in this patch: one fit, one undo, and no window
    // where the manifest pins bytes that are no longer on disk.
    const op: JsonPatchOp[] = sameRig
      ? []
      : [{ op: current ? 'replace' : 'add', path: '/rig', value: rig }];
    if (opts.canonicalMesh !== undefined) op.push(canonicalMeshOp(manifest, opts.canonicalMesh));
    return {
      op,
      label: opts.label ??
        (rig.jointEdits.length > 0
          ? `Edit ${rig.jointEdits.length} joint${rig.jointEdits.length === 1 ? '' : 's'}`
          : `Rig (${rig.jointCount} joints, track ${rig.track})`),
    };
  }, opts);
}

/**
 * Record the look (P4-T2), as a journaled patch — so choosing a camera or a
 * style is undoable like every other decision, and `bake` inherits it without
 * being the only verb that can write it.
 *
 * The caller passes the RESOLVED look object; validation of the merged
 * preset+overrides belongs upstream (resolveCamera/resolveStyle refuse an
 * illegal combination), because a manifest should never record a look that
 * cannot bake.
 */
export async function setLook(
  workspace: string,
  look: NonNullable<CharacterManifest['look']>,
  opts: ReceiptOptions & { label: string },
): Promise<CharacterManifest> {
  return await commit(workspace, (manifest) => {
    if (canonicalJson(manifest.look ?? null) === canonicalJson(look)) {
      throw new Error('setLook was given the look the character already has.');
    }
    return {
      op: [{
        op: manifest.look === undefined ? 'add' : 'replace',
        path: '/look',
        value: look,
      }],
      label: opts.label,
    };
  }, opts);
}

/**
 * Record the clip bindings (P4-T2), as a journaled patch: `anim --enable` and
 * `--disable` are decisions exactly like `rig --accept`, and one undo takes a
 * binding change back. Replaced wholesale for the same reason RigState is —
 * the caller merged deliberately; a second merge here would double the policy.
 */
export async function setAnimationSet(
  workspace: string,
  bindings: ClipBinding[],
  opts: ReceiptOptions & { label: string },
): Promise<CharacterManifest> {
  return await commit(workspace, (manifest) => {
    if (canonicalJson(manifest.animationSet ?? null) === canonicalJson(bindings)) {
      throw new Error('setAnimationSet was given the bindings the character already has.');
    }
    return {
      op: [{
        op: manifest.animationSet === undefined ? 'add' : 'replace',
        path: '/animationSet',
        value: bindings,
      }],
      label: opts.label,
    };
  }, opts);
}

export interface IdentityFields {
  detailLayers?: DetailLayer[];
  attachments?: Attachment[];
  /** region id -> replacement mesh path; lives INSIDE rig (RigState.boneMask) */
  boneMask?: Record<string, string>;
  /**
   * The canonical mesh re-pin, in the SAME patch. Applying identity rewrites
   * canonical/model.glb, so its hash changes with the identity that produced
   * it — journaling them separately would let one undo leave a manifest
   * claiming no identity for bytes that carry the tattoo, and the recovery
   * path (re-pick, replay what the manifest describes) would then produce
   * bytes contradicting the pinned hash.
   */
  canonicalMesh?: CanonicalMeshPatch;
}

/**
 * Record the identity layer (P3-T4/Track A) as ONE journaled patch: decals,
 * attachments, and the bone mask land together because they were applied
 * together — a user undoing "add the tattoo and the sword" expects one undo,
 * not three. Each provided field replaces wholesale (identity is declarative:
 * the manifest states what the character HAS, not a diff of what changed).
 *
 * boneMask patches into `rig.boneMask`, so it requires a rig — replacing
 * regions of a body that has no skeleton yet is not a meaningful operation,
 * and the error says which verb to run first.
 */
export async function setIdentity(
  workspace: string,
  fields: IdentityFields,
  opts: ReceiptOptions = {},
): Promise<CharacterManifest> {
  const provided = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (provided.length === 0) {
    throw new Error('setIdentity was given nothing to record.');
  }
  return await commit(workspace, (manifest) => {
    const op: JsonPatchOp[] = [];
    const parts: string[] = [];
    if (fields.detailLayers !== undefined) {
      op.push({
        op: manifest.detailLayers === undefined ? 'add' : 'replace',
        path: '/detailLayers',
        value: fields.detailLayers,
      });
      parts.push(
        `${fields.detailLayers.length} decal${fields.detailLayers.length === 1 ? '' : 's'}`,
      );
    }
    if (fields.attachments !== undefined) {
      op.push({
        op: manifest.attachments === undefined ? 'add' : 'replace',
        path: '/attachments',
        value: fields.attachments,
      });
      parts.push(
        `${fields.attachments.length} attachment${fields.attachments.length === 1 ? '' : 's'}`,
      );
    }
    if (fields.boneMask !== undefined) {
      if (!manifest.rig) {
        throw new Error(
          'A bone mask replaces regions of a RIGGED body, and this character has no rig yet - ' +
            'run `spritebook rig` first.',
        );
      }
      op.push({
        op: manifest.rig.boneMask === undefined ? 'add' : 'replace',
        path: '/rig/boneMask',
        value: fields.boneMask,
      });
      parts.push(`bone mask (${Object.keys(fields.boneMask).length} regions)`);
    }
    if (fields.canonicalMesh !== undefined) {
      op.push(canonicalMeshOp(manifest, fields.canonicalMesh));
    }
    return { op, label: opts.label ?? `Identity: ${parts.join(', ')}` };
  }, opts);
}

export interface BakeRecord {
  /** the camera + style the bake actually ran with, ids and all */
  look: NonNullable<CharacterManifest['look']>;
  /** the clip bindings the bake ran with; absent leaves the stored ones alone */
  animationSet?: ClipBinding[];
  /** the D-008 choice the bake ran with */
  mirroring: boolean;
  /** first 8 hex of the bake's cache key — the bake dir's name */
  lastBakeId: string;
}

/**
 * Record what a bake ran with (D-029): its look, its clips, its mirroring, and
 * the bake it produced — as ONE journaled patch.
 *
 * One patch, not four, and that is the whole point. `lastBakeId` names a bake
 * dir whose manifest pins the look and clips beside it here; splitting them
 * would let a single `spritebook undo` roll back the look while leaving
 * `lastBakeId` pointing at atlases baked from it, so the manifest would
 * describe a character whose most recent bake does not match its own settings.
 * `mirroring` is the sharpest case: undo it alone and the manifest claims
 * symmetry for a bake whose back half is literally flipped copies.
 * Same argument as `setIdentity`'s decals + attachments + mesh re-pin.
 *
 * A bake that changes nothing (same look, same clips, same inputs, so the same
 * bakeId) journals nothing at all — re-running a bake is not an edit, and an
 * undo stack full of empty steps is an undo stack a human stops trusting.
 */
export async function recordBake(
  workspace: string,
  record: BakeRecord,
  opts: ReceiptOptions = {},
): Promise<CharacterManifest> {
  return await commit(workspace, (manifest) => {
    const op: JsonPatchOp[] = [];
    if (canonicalJson(record.look) !== canonicalJson(manifest.look ?? null)) {
      op.push(setOp('/look', record.look, manifest.look));
    }
    // absent means "this bake did not settle the question" — an idle-stub bake
    // ran no clips, which is not the same statement as "this character has
    // none", and clearing the bindings on its way past would delete a choice it
    // was never asked about
    if (
      record.animationSet !== undefined &&
      canonicalJson(record.animationSet) !== canonicalJson(manifest.animationSet ?? null)
    ) {
      op.push(setOp('/animationSet', record.animationSet, manifest.animationSet));
    }
    // always a `replace`: `mirroring` is required on the manifest, so it is
    // never absent and an `add` would invert to a `remove` of a required field
    if (record.mirroring !== manifest.mirroring.enabled) {
      op.push({ op: 'replace', path: '/mirroring/enabled', value: record.mirroring });
    }
    if (record.lastBakeId !== manifest.lastBakeId) {
      op.push(setOp('/lastBakeId', record.lastBakeId, manifest.lastBakeId));
    }
    return { op, label: opts.label ?? `Bake ${record.lastBakeId}` };
  }, opts);
}

/**
 * The `/canonicalMesh` replace op, shared by setCanonicalMesh and the writers
 * that re-pin the mesh as part of a larger single step. Returns nothing to
 * apply when the fields change nothing, so a caller can pass the current hash
 * without generating a no-op op.
 */
function canonicalMeshOp(
  manifest: CharacterManifest,
  fields: CanonicalMeshPatch,
): JsonPatchOp {
  const current = manifest.canonicalMesh;
  if (!current) {
    throw new Error(
      `This character has no canonical mesh yet - pick a generation result first; that is ` +
        `what writes the first one.`,
    );
  }
  return { op: 'replace', path: '/canonicalMesh', value: { ...current, ...defined(fields) } };
}

function commit(
  workspace: string,
  build: (manifest: CharacterManifest) => { op: JsonPatchOp[]; label: string },
  opts: ReceiptOptions,
): Promise<CharacterManifest> {
  return commitManifest(workspacePaths(workspace).manifest, build, opts.now, opts.canonicalSource);
}

export { writeAtomic } from './persistence.ts';

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
