/**
 * Tier-1 repairs: joint nudges (P3-T3).
 *
 * The two-tier repair model comes from what P0-T4 actually saw go wrong. Tier
 * 2 is structural and cheap (the whole model is rotated or grounded). Tier 1
 * is surgical: a specific joint is in the wrong place, and the user knows
 * where it belongs. Both are recorded in `RigState` so a rig is reproducible
 * from its history rather than from whatever happened to be on disk.
 *
 * ## Why an edit is also a hint
 *
 * The naive design applies a nudge and forgets it, so re-running the rig
 * throws the user's correction away and they fix the same shoulder again. So
 * `jointEdits` double as the input to `--rerun-with-hints`: a nudge the user
 * already made becomes a MARKER the model is asked to respect next time. That
 * is why the edit records a delta AND the resulting absolute position can be
 * derived — the model wants "put it here", the journal wants "the user moved
 * it by this much".
 *
 * ## Mirroring is opt-in, per edit
 *
 * D-008 makes asymmetry first-class: a character with one prosthetic arm must
 * never have a shoulder fix silently mirrored onto a limb that is deliberately
 * different. So `mirrored` is a property of each edit, defaulting to false,
 * and the side partner is found by the profile's explicit naming convention
 * rather than by guessing from geometry (P0-T4 catalog item 6: geometric side
 * detection ties itself to float noise).
 */
import { NodeIO } from '@gltf-transform/core';
import type { JointEdit, RigHint, RigSkeleton } from '@spritebook/schema';

/** `_l`/`_r`, `Left`/`Right`, `.L`/`.R` — the conventions rigs actually use. */
const SIDE_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^(.*)_l$/i, (m) => `${m[1]}_r`],
  [/^(.*)_r$/i, (m) => `${m[1]}_l`],
  [/^(.*)\.L$/, (m) => `${m[1]}.R`],
  [/^(.*)\.R$/, (m) => `${m[1]}.L`],
  [/^Left(.*)$/, (m) => `Right${m[1]}`],
  [/^Right(.*)$/, (m) => `Left${m[1]}`],
];

/**
 * The name of `joint`'s side partner, or null when the name carries no side.
 * Naming only — never geometry (catalog item 6).
 */
export function sidePartner(joint: string): string | null {
  for (const [re, swap] of SIDE_PATTERNS) {
    const m = joint.match(re);
    if (m) return swap(m);
  }
  return null;
}

export interface ApplyEditsResult {
  /** joints actually moved, in application order */
  moved: string[];
  /** edits naming a joint the skeleton does not have */
  unknownJoints: string[];
  /** mirrored edits whose partner was missing — reported, never guessed at */
  missingPartners: string[];
  skeleton: RigSkeleton;
}

/**
 * Apply joint nudges to a skeleton. Pure: returns a new skeleton, so the
 * caller decides what to persist. An edit naming an unknown joint is REPORTED
 * rather than ignored — a typo that silently does nothing is how a user
 * concludes the verb is broken.
 *
 * The mirrored delta negates X, which is the mirror plane for every convention
 * SpriteBook canonicalizes to (+Y up, +Z forward, so left-right is X).
 */
export function applyJointEdits(
  skeleton: RigSkeleton,
  edits: JointEdit[],
): ApplyEditsResult {
  const joints = skeleton.joints.map((j) => ({
    ...j,
    head: [...j.head] as [number, number, number],
    tail: [...j.tail] as [number, number, number],
  }));
  const byName = new Map(joints.map((j, i) => [j.name, i]));
  const moved: string[] = [];
  const unknownJoints: string[] = [];
  const missingPartners: string[] = [];

  const nudge = (name: string, d: [number, number, number]) => {
    const idx = byName.get(name);
    if (idx === undefined) return false;
    const j = joints[idx];
    for (let c = 0; c < 3; c++) {
      j.head[c] += d[c];
      j.tail[c] += d[c];
    }
    moved.push(name);
    return true;
  };

  for (const edit of edits) {
    if (!nudge(edit.joint, edit.delta)) {
      unknownJoints.push(edit.joint);
      continue;
    }
    if (!edit.mirrored) continue;
    const partner = sidePartner(edit.joint);
    if (partner === null || !byName.has(partner)) {
      missingPartners.push(edit.joint);
      continue;
    }
    nudge(partner, [-edit.delta[0], edit.delta[1], edit.delta[2]]);
  }

  return { moved, unknownJoints, missingPartners, skeleton: { ...skeleton, joints } };
}

/**
 * Turn the edits a user has already made into placement markers for the next
 * prediction — the whole point of `--rerun-with-hints`. Hints are ABSOLUTE
 * positions (where the joint should end up), taken from the edited skeleton,
 * because "move it 3 cm left" means nothing to a model that is about to
 * predict a different starting position.
 */
export function hintsFromEdits(edited: RigSkeleton, edits: JointEdit[]): RigHint[] {
  const byName = new Map(edited.joints.map((j) => [j.name, j]));
  const named = new Set<string>();
  for (const e of edits) {
    named.add(e.joint);
    if (e.mirrored) {
      const p = sidePartner(e.joint);
      if (p) named.add(p);
    }
  }
  const hints: RigHint[] = [];
  for (const name of [...named].sort()) {
    const joint = byName.get(name);
    if (joint) hints.push({ joint: name, position: [...joint.head] });
  }
  return hints;
}

/**
 * Move the joint NODES of an already-rigged glb to match an edited skeleton.
 *
 * Only the joint nodes' translations change: vertex data and the skin's
 * weights are untouched, so a nudge is cheap and cannot corrupt the skinning.
 * The inverse bind matrices ARE updated, because they encode the rest pose the
 * weights were computed against — leaving them stale is the classic way a
 * "small joint fix" explodes a character the first time it is posed.
 */
export async function applyEditsToRiggedGlb(
  inPath: string,
  outPath: string,
  before: RigSkeleton,
  after: RigSkeleton,
): Promise<{ updatedJoints: number }> {
  const io = new NodeIO();
  const doc = await io.readBinary(await Deno.readFile(inPath));
  const deltas = new Map<string, [number, number, number]>();
  for (const [i, j] of after.joints.entries()) {
    const b = before.joints[i];
    if (!b || b.name !== j.name) continue;
    const d: [number, number, number] = [
      j.head[0] - b.head[0],
      j.head[1] - b.head[1],
      j.head[2] - b.head[2],
    ];
    if (d[0] !== 0 || d[1] !== 0 || d[2] !== 0) deltas.set(j.name, d);
  }

  let updatedJoints = 0;
  const skins = doc.getRoot().listSkins();
  for (const skin of skins) {
    const jointNodes = skin.listJoints();
    for (const node of jointNodes) {
      const d = deltas.get(node.getName());
      if (!d) continue;
      const t = node.getTranslation();
      node.setTranslation([t[0] + d[0], t[1] + d[1], t[2] + d[2]]);
      updatedJoints++;
    }
    // recompute IBMs from the NEW rest pose: they are the inverse of each
    // joint's world matrix, and the weights were solved against that pose
    const ibm = skin.getInverseBindMatrices();
    if (!ibm) continue;
    const out = new Float32Array(jointNodes.length * 16);
    for (const [i, node] of jointNodes.entries()) {
      const inv = invert4(node.getWorldMatrix() as unknown as number[]);
      if (inv === null) {
        throw new Error(
          `rig --edits: joint "${node.getName()}" ended up with a non-invertible world ` +
            `matrix after the nudge - the edit collapsed its scale`,
        );
      }
      out.set(inv, i * 16);
    }
    ibm.setArray(out as Float32Array<ArrayBuffer>);
  }
  await Deno.writeFile(outPath, await io.writeBinary(doc));
  return { updatedJoints };
}

/** General 4x4 inverse (column-major); null when singular. */
function invert4(m: number[]): Float32Array | null {
  const a = m;
  const inv = new Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] +
    a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] -
    a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] +
    a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] -
    a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] -
    a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] +
    a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] -
    a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] +
    a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] +
    a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] -
    a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] +
    a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] -
    a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] -
    a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] +
    a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] -
    a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] +
    a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = inv[i] / det;
  return out;
}
