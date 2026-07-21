/**
 * Apply NEUTRAL rig data to the canonical mesh (P3-T3): `rig.json` +
 * `rig.npz` in, a real glTF skin out. This is the core half of the licence
 * boundary schema/rig.ts draws — bpy runs inside the sidecar, the adapter
 * returns plain arrays, and the skin that lands in the manifest is built by
 * code we can test.
 *
 * ## Joint frames: Y-along-bone, shortest arc
 *
 * Each joint node is placed at its `head` and rotated by the SHORTEST-ARC
 * rotation taking local +Y onto the head->tail direction, so a joint's local +Y
 * always points down its own bone. Two reasons, in order:
 *
 * 1. glTF has no bone length or tail. If the frame does not carry the tail
 *    direction, the tail is simply LOST at this seam — and `deformCheck` reads
 *    the rigged glb alone, so it would have to guess a bend axis from child
 *    positions, which is wrong for every disconnected bone (a hand whose tail
 *    points down the palm, a jaw, any leaf). Baking the direction into the
 *    frame keeps the adapter's own answer authoritative all the way through.
 * 2. Shortest arc is the one canonical choice. Head and tail constrain two of
 *    three rotational degrees of freedom; the roll about the bone is free, so
 *    any convention has to pin it. Shortest arc pins it with no reference-up
 *    vector to argue about, is continuous in the bone direction (no flip when
 *    a limb crosses an arbitrary plane), and is exactly reproducible from the
 *    rig.json alone. The two degenerate cases are named and fixed: a
 *    zero-length bone gets identity, an exactly-antiparallel bone (tail below
 *    head, +Y -> -Y) gets the 180-degree turn about +X.
 *
 * Rest world matrix is therefore `W = T(head) . R`, rigid with unit scale, and
 * the inverse bind matrix is its EXACT rigid inverse `[R^T | -R^T . head]` —
 * never a general matrix solve, so `world . IBM = I` holds to float32 and the
 * rest round-trip lands on the authored vertex positions.
 *
 * Heads and tails are read in the same space as the POSITION accessors (the
 * contract's "the MESH's own space"), which is exactly the space glTF skinning
 * binds against, so the joint root is attached to the scene with no inherited
 * transform. The skinned mesh node's own transform is ignored, per the glTF
 * spec and per `packages/render/skinning.ts`.
 *
 * ## Attribute encoding
 *
 * - `JOINTS_0` is UNSIGNED_BYTE when the skeleton fits in 256 joints (every
 *   Track B rig: 22-52) and UNSIGNED_SHORT otherwise — the two types glTF
 *   allows. Smallest-that-fits keeps the canonical asset small without ever
 *   risking an index that does not fit.
 * - `WEIGHTS_0` is FLOAT, not a normalized integer. glTF accepts either, and
 *   float is the right call for a source-of-truth artifact: quantizing to u8
 *   costs up to 1/255 per component and then breaks the sum-to-1 invariant
 *   that was just repaired, which is precisely the "renormalize after
 *   quantize" bug the gltf-pipeline-processing skill warns about ("do not
 *   quantize canonical assets").
 *
 * ## Weight repairs, counted not assumed
 *
 * Rows are repaired in a fixed order and every repair is COUNTED, because the
 * sidecar-vram skill's lesson is that a model stage's output is garbage long
 * before anything throws: more than four influences keeps the four heaviest;
 * a row summing to zero is rigid-bound to the root joint and reported (never a
 * divide by zero, and never the origin-collapse the contract warns about — the
 * P0-T4 `neutral_bone` symptom); anything else off by more than 1e-6 is
 * divided by its sum. The written arrays are then re-validated from scratch.
 */
import { type Document, type Node, NodeIO } from '@gltf-transform/core';
import { RigSkeletonSchema } from '@spritebook/schema';
import {
  qConj,
  qIdentity,
  qMul,
  qNormalize,
  qRotate,
  qToMat4,
  type Quat,
  vCross,
  vDot,
  type Vec3,
  vLen,
  vNormalize,
  vSub,
} from '../anim/quat.ts';
import { readNpzFile } from './npz.ts';
import { mat4InvertRigid, mat4Multiply } from './skin.ts';

/** Name given to the skin this writer creates. */
export const RIG_SKIN_NAME = 'rig';
/** A bone shorter than this has no direction; its joint frame is identity. */
export const BONE_EPS_M = 1e-9;
/** Row sums at or below this are "no influence at all", not "needs a rescale". */
export const ZERO_WEIGHT_EPS = 1e-8;
/** Rows further than this from summing to 1 are renormalized (and counted). */
export const WEIGHT_SUM_EPS = 1e-6;
/** Post-encode row-sum tolerance: float32 rounding of four components. */
export const WEIGHT_SUM_TOLERANCE = 1e-5;
/** Weights this far below zero are solver noise and clamp; beyond, we throw. */
export const NEGATIVE_WEIGHT_EPS = 1e-6;
/** `world . IBM` must be the identity to this tolerance, per element. */
export const IBM_IDENTITY_TOLERANCE = 1e-5;

export interface ApplyRigOptions {
  /** the canonical mesh to rig (glb) */
  meshPath: string;
  /** the adapter's rig.json (RigSkeleton) */
  skeletonPath: string;
  /** the adapter's rig.npz (`joints` + `weights`) */
  weightsPath: string;
  /** where the rigged glb is written */
  outPath: string;
}

export interface ApplyRigResult {
  jointCount: number;
  vertexCount: number;
  /** rows whose weights did not sum to 1 and were rescaled */
  renormalizedVertices: number;
  /** rows with no influence at all — rigid-bound to the root joint, reported */
  zeroWeightVertices: number;
  /**
   * rows that carried more than glTF's four influences; the four heaviest were
   * kept. Additive to the frozen result shape: dropping influence silently is
   * exactly the kind of quiet loss the deform check exists to catch.
   */
  truncatedVertices: number;
  skeletonProfile: 'generic';
}

const UP: Vec3 = [0, 1, 0];

/**
 * Shortest-arc rotation from +Y to the head->tail direction. The half-angle
 * form `(u x v, 1 + u.v)` is used rather than axis+acos: it is accurate for
 * nearly-parallel bones, where acos loses most of its precision.
 */
export function boneRotation(head: Vec3, tail: Vec3): Quat {
  const d = vSub(tail, head);
  if (vLen(d) < BONE_EPS_M) return qIdentity(); // zero-length bone: no direction
  const n = vNormalize(d);
  const c = vDot(UP, n);
  if (c > 1 - 1e-12) return qIdentity();
  if (c < -1 + 1e-12) return [1, 0, 0, 0]; // antiparallel: 180 degrees about +X
  const axis = vCross(UP, n);
  return qNormalize([axis[0], axis[1], axis[2], 1 + c]);
}

/** Rest world matrix `T(head) . R` for a joint, column-major. */
function restWorld(head: Vec3, rot: Quat): Float32Array {
  const m = qToMat4(rot);
  m[12] = head[0], m[13] = head[1], m[14] = head[2];
  return m;
}

interface PrimitiveSlot {
  meshName: string;
  primIndex: number;
  vertexCount: number;
  firstVertex: number;
  setJoints: (a: Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer>) => void;
  setWeights: (a: Float32Array<ArrayBuffer>) => void;
}

/**
 * Every primitive of every mesh, in `listMeshes()`/`listPrimitives()` order —
 * the SAME order `packages/render/skinning.ts` concatenates them in, which is
 * the order the adapter's per-vertex rows are indexed by. A mesh no node
 * references cannot be bound to a skin, so it fails here rather than at the
 * importer border on the next pass.
 */
function primitiveSlots(doc: Document, label: string): PrimitiveSlot[] {
  const root = doc.getRoot();
  const meshes = root.listMeshes();
  if (meshes.length === 0) throw new Error(`${label}: no mesh to rig`);
  const referenced = new Set(root.listNodes().map((n) => n.getMesh()).filter(Boolean));
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const slots: PrimitiveSlot[] = [];
  let first = 0;
  for (const mesh of meshes) {
    if (!referenced.has(mesh)) {
      throw new Error(
        `${label}: mesh "${mesh.getName()}" is not referenced by any node — ` +
          'a skin can only be bound through a node',
      );
    }
    mesh.listPrimitives().forEach((prim, primIndex) => {
      const pos = prim.getAttribute('POSITION');
      if (!pos) {
        throw new Error(
          `${label}: mesh "${mesh.getName()}" primitive ${primIndex} has no POSITION`,
        );
      }
      const vertexCount = pos.getArray()!.length / 3;
      slots.push({
        meshName: mesh.getName(),
        primIndex,
        vertexCount,
        firstVertex: first,
        setJoints: (a) =>
          prim.setAttribute(
            'JOINTS_0',
            doc.createAccessor().setType('VEC4').setArray(a).setBuffer(buffer),
          ),
        setWeights: (a) =>
          prim.setAttribute(
            'WEIGHTS_0',
            doc.createAccessor().setType('VEC4').setArray(a).setBuffer(buffer),
          ),
      });
      first += vertexCount;
    });
  }
  return slots;
}

/** Build the joint node hierarchy + rest/inverse-bind matrices. */
function buildJoints(
  doc: Document,
  joints: { name: string; parent: number; head: Vec3; tail: Vec3 }[],
  label: string,
): {
  nodes: Node[];
  worlds: Float32Array<ArrayBuffer>;
  ibm: Float32Array<ArrayBuffer>;
  roots: Node[];
} {
  const seen = new Map<string, number>();
  joints.forEach((j, i) => {
    const prev = seen.get(j.name);
    if (prev !== undefined) {
      throw new Error(
        `${label}: duplicate joint name "${j.name}" (indices ${prev} and ${i}) — ` +
          'names address joints in hints, edits and bone masks, so they must be unique',
      );
    }
    seen.set(j.name, i);
    if (j.parent >= i) {
      throw new Error(
        `${label}: joint "${j.name}" (index ${i}) has parent index ${j.parent} — ` +
          'parents must precede children (the contract guarantees topological order)',
      );
    }
    for (const [what, v] of [['head', j.head], ['tail', j.tail]] as const) {
      if (!v.every(Number.isFinite)) {
        throw new Error(`${label}: joint "${j.name}" has a non-finite ${what} [${v.join(', ')}]`);
      }
    }
  });

  const n = joints.length;
  const rots: Quat[] = [];
  const worlds = new Float32Array(n * 16);
  const ibm = new Float32Array(n * 16);
  const nodes: Node[] = [];
  const roots: Node[] = [];

  joints.forEach((j, i) => {
    const rot = boneRotation(j.head, j.tail);
    rots.push(rot);
    worlds.set(restWorld(j.head, rot), i * 16);
    ibm.set(mat4InvertRigid(worlds.subarray(i * 16, i * 16 + 16)), i * 16);

    const node = doc.createNode(j.name);
    if (j.parent < 0) {
      node.setTranslation(j.head).setRotation(rot);
      roots.push(node);
    } else {
      const p = joints[j.parent];
      const pInv = qConj(rots[j.parent]);
      node.setTranslation(qRotate(pInv, vSub(j.head, p.head)))
        .setRotation(qNormalize(qMul(pInv, rot)));
      nodes[j.parent].addChild(node);
    }
    nodes.push(node);
  });

  // world . IBM = I, per joint, per element: the numeric proof that the bind
  // matrices invert the frames we just built (skill: validate numerically)
  const check = new Float32Array(16);
  for (let i = 0; i < n; i++) {
    mat4Multiply(worlds.subarray(i * 16, i * 16 + 16), ibm.subarray(i * 16, i * 16 + 16), check);
    for (let e = 0; e < 16; e++) {
      const want = e % 5 === 0 ? 1 : 0;
      if (!Number.isFinite(check[e]) || Math.abs(check[e] - want) > IBM_IDENTITY_TOLERANCE) {
        throw new Error(
          `${label}: joint "${joints[i].name}" inverse bind matrix does not invert its ` +
            `rest transform (element ${e} of world.IBM is ${check[e]}, expected ${want})`,
        );
      }
    }
  }
  return { nodes, worlds, ibm, roots };
}

interface WeightRows {
  joints: Uint32Array; // 4 per vertex
  weights: Float32Array; // 4 per vertex
  renormalizedVertices: number;
  zeroWeightVertices: number;
  truncatedVertices: number;
}

/**
 * Reduce the adapter's (vertexCount x influencesPerVertex) rows to glTF's four
 * slots, repairing and counting as documented in the module header. Every
 * failure names the vertex and the slot — a NaN in row 21847 is findable, a
 * stack trace is not.
 */
export function packWeightRows(
  rawJoints: ArrayLike<number>,
  rawWeights: ArrayLike<number>,
  vertexCount: number,
  influences: number,
  jointCount: number,
  label: string,
): WeightRows {
  const joints = new Uint32Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  let renormalizedVertices = 0;
  let zeroWeightVertices = 0;
  let truncatedVertices = 0;

  const slots: { j: number; w: number }[] = [];
  for (let v = 0; v < vertexCount; v++) {
    slots.length = 0;
    for (let k = 0; k < influences; k++) {
      const idx = rawJoints[v * influences + k];
      let w = rawWeights[v * influences + k];
      if (!Number.isFinite(w)) {
        throw new Error(
          `${label}: vertex ${v} influence ${k} has a non-finite weight (${w}) — ` +
            'the adapter emitted an invalid skin (NaN census: sidecar-vram skill)',
        );
      }
      if (w < 0) {
        if (w < -NEGATIVE_WEIGHT_EPS) {
          throw new Error(`${label}: vertex ${v} influence ${k} has a negative weight (${w})`);
        }
        w = 0; // solver noise
      }
      if (!Number.isInteger(idx) || idx < 0 || idx >= jointCount) {
        // a zero weight on an out-of-range index is still a broken row: the
        // index reaches the file, and glTF validators reject it
        throw new Error(
          `${label}: vertex ${v} influence ${k} references joint index ${idx} but the ` +
            `skeleton has ${jointCount} joints (0..${jointCount - 1})`,
        );
      }
      slots.push({ j: idx, w });
    }

    if (influences > 4) {
      slots.sort((a, b) => b.w - a.w || a.j - b.j); // stable: index breaks ties
      let dropped = 0;
      for (let k = 4; k < slots.length; k++) dropped += slots[k].w;
      slots.length = 4;
      if (dropped > 0) truncatedVertices++;
    }

    let sum = 0;
    for (const s of slots) sum += s.w;
    if (sum <= ZERO_WEIGHT_EPS) {
      // rigid-bind to the root joint: attached to the character, never at the
      // origin, and never a division by zero
      zeroWeightVertices++;
      joints[v * 4] = 0;
      weights[v * 4] = 1;
      continue;
    }
    if (Math.abs(sum - 1) > WEIGHT_SUM_EPS) {
      renormalizedVertices++;
      for (const s of slots) s.w /= sum;
    }
    for (let k = 0; k < slots.length && k < 4; k++) {
      joints[v * 4 + k] = slots[k].j;
      weights[v * 4 + k] = slots[k].w;
    }
  }
  return { joints, weights, renormalizedVertices, zeroWeightVertices, truncatedVertices };
}

/** Final gate before bytes hit disk: indices in range, weights finite and unit. */
function validateRows(rows: WeightRows, vertexCount: number, jointCount: number, label: string) {
  for (let v = 0; v < vertexCount; v++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const j = rows.joints[v * 4 + k];
      const w = rows.weights[v * 4 + k];
      if (j >= jointCount) {
        throw new Error(
          `${label}: vertex ${v} slot ${k} holds joint index ${j} of ${jointCount}`,
        );
      }
      if (!Number.isFinite(w)) {
        throw new Error(`${label}: vertex ${v} slot ${k} holds a non-finite weight (${w})`);
      }
      sum += w;
    }
    if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
      throw new Error(
        `${label}: vertex ${v} weights sum to ${sum}, expected 1 +/- ${WEIGHT_SUM_TOLERANCE}`,
      );
    }
  }
}

/**
 * Read the adapter's two files, build the skin on the canonical mesh, validate
 * it numerically, and write the rigged glb.
 */
export async function applyRig(opts: ApplyRigOptions): Promise<ApplyRigResult> {
  const label = 'applyRig';

  // ---- skeleton ----------------------------------------------------------
  let skeletonJson: unknown;
  try {
    skeletonJson = JSON.parse(await Deno.readTextFile(opts.skeletonPath));
  } catch (err) {
    throw new Error(
      `${label}: cannot read skeleton "${opts.skeletonPath}" (${(err as Error).message})`,
    );
  }
  const parsed = RigSkeletonSchema.safeParse(skeletonJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `${label}: "${opts.skeletonPath}" is not a RigSkeleton — ` +
        `${first.path.join('.') || '(root)'}: ${first.message}`,
    );
  }
  const skeleton = parsed.data;
  const jointCount = skeleton.joints.length;
  if (jointCount > 65536) {
    throw new Error(`${label}: ${jointCount} joints exceeds glTF's 65536 JOINTS_0 range`);
  }
  if (skeleton.joints[0].parent !== -1) {
    throw new Error(`${label}: joint 0 ("${skeleton.joints[0].name}") must be a root (parent -1)`);
  }

  // ---- weights -----------------------------------------------------------
  const npz = await readNpzFile(opts.weightsPath);
  const present = [...npz.keys()].sort().join(', ') || '(empty)';
  const rawJoints = npz.get('joints');
  const rawWeights = npz.get('weights');
  if (!rawJoints || !rawWeights) {
    throw new Error(
      `${label}: "${opts.weightsPath}" is missing the ` +
        `${!rawJoints ? '"joints"' : '"weights"'} array — it holds: ${present}`,
    );
  }
  const wantShape = [skeleton.vertexCount, skeleton.influencesPerVertex];
  for (const [name, arr] of [['joints', rawJoints], ['weights', rawWeights]] as const) {
    if (arr.shape.length !== 2 || arr.shape[0] !== wantShape[0] || arr.shape[1] !== wantShape[1]) {
      throw new Error(
        `${label}: "${opts.weightsPath}" array "${name}" has shape ` +
          `[${arr.shape.join(', ')}], expected [${wantShape.join(', ')}] from ` +
          `"${opts.skeletonPath}" (vertexCount x influencesPerVertex)`,
      );
    }
  }
  if (rawJoints.dtype === 'float32') {
    throw new Error(
      `${label}: "${opts.weightsPath}" array "joints" is float32 — joint indices must be ` +
        'an integer dtype (uint8, uint16, uint32, int32)',
    );
  }
  if (rawWeights.dtype !== 'float32') {
    throw new Error(
      `${label}: "${opts.weightsPath}" array "weights" is ${rawWeights.dtype}, expected float32`,
    );
  }

  // ---- mesh --------------------------------------------------------------
  const io = new NodeIO();
  let doc: Document;
  try {
    doc = await io.readBinary(await Deno.readFile(opts.meshPath));
  } catch (err) {
    throw new Error(`${label}: cannot read mesh "${opts.meshPath}" (${(err as Error).message})`);
  }
  if (doc.getRoot().listSkins().length > 0) {
    throw new Error(
      `${label}: "${opts.meshPath}" already has a skin — rig the unrigged canonical mesh`,
    );
  }
  const slots = primitiveSlots(doc, `${label}: "${opts.meshPath}"`);
  const meshVertices = slots.reduce((s, p) => s + p.vertexCount, 0);
  if (meshVertices !== skeleton.vertexCount) {
    throw new Error(
      `${label}: "${opts.meshPath}" has ${meshVertices} vertices but "${opts.skeletonPath}" ` +
        `declares ${skeleton.vertexCount} — the rig was predicted for a different mesh`,
    );
  }

  // ---- skin --------------------------------------------------------------
  const { nodes, ibm, roots } = buildJoints(
    doc,
    skeleton.joints.map((j) => ({
      name: j.name,
      parent: j.parent,
      head: [...j.head] as Vec3,
      tail: [...j.tail] as Vec3,
    })),
    `${label}: "${opts.skeletonPath}"`,
  );

  const rows = packWeightRows(
    rawJoints.data,
    rawWeights.data,
    skeleton.vertexCount,
    skeleton.influencesPerVertex,
    jointCount,
    `${label}: "${opts.weightsPath}"`,
  );
  validateRows(rows, skeleton.vertexCount, jointCount, `${label}: "${opts.weightsPath}"`);

  const narrow = jointCount <= 256;
  for (const slot of slots) {
    const from = slot.firstVertex * 4;
    const to = from + slot.vertexCount * 4;
    const src = rows.joints.subarray(from, to);
    slot.setJoints(narrow ? Uint8Array.from(src) : Uint16Array.from(src));
    slot.setWeights(rows.weights.slice(from, to));
  }

  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const skin = doc.createSkin(RIG_SKIN_NAME)
    .setSkeleton(roots[0])
    .setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));
  for (const node of nodes) skin.addJoint(node);

  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) throw new Error(`${label}: "${opts.meshPath}" has no scene to attach the rig to`);
  for (const root of roots) scene.addChild(root);
  for (const node of doc.getRoot().listNodes()) {
    if (node.getMesh()) node.setSkin(skin);
  }

  await Deno.writeFile(opts.outPath, await io.writeBinary(doc));

  return {
    jointCount,
    vertexCount: skeleton.vertexCount,
    renormalizedVertices: rows.renormalizedVertices,
    zeroWeightVertices: rows.zeroWeightVertices,
    truncatedVertices: rows.truncatedVertices,
    skeletonProfile: 'generic',
  };
}
