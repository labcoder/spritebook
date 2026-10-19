/**
 * Canonicalization chain (D-012): resample/prune/dedup/weld under SUPERVISION
 * (a pass that changes skin/joint/mesh counts is a failed import, not a
 * cleanup — skill law), then convention enforcement: +Y up, meters, faces +Z
 * (VRM 0.x rotated 180°), feet at Y=0, uniform rescale to declared height.
 * No quantize — canonical assets are the lossless source of truth.
 *
 * Normalization is skin-aware and lives entirely in the TRANSFORMS: uniform
 * scale s and Y-offset go onto the scene's root-node matrices, and every
 * inverse bind matrix becomes IBM · N⁻¹, keeping joint_world · IBM ≈ I — tested
 * invariant. VERTEX POSITIONS ARE NEVER TOUCHED (applyNormalization says so at
 * its definition, and this header used to claim the opposite). That is the only
 * formulation that is exact for skins, and it is why a consumer must compose
 * node transforms to see the normalized character.
 */
import type { Document, Node } from '@gltf-transform/core';
import { getBounds } from '@gltf-transform/core';
import { dedup, normals, prune, resample, weld } from '@gltf-transform/functions';
import { ImportError } from './errors.ts';

export interface CanonNote {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  fixApplied?: string;
}

export interface CanonicalizeOptions {
  /** rescale so standing height equals this (meters); skip when undefined */
  declaredHeightM?: number;
  /** VRM 0.x sources face -Z and get the 180° yaw correction */
  rotate180Y?: boolean;
  /** file label for error messages */
  label: string;
}

interface Counts {
  nodes: number;
  meshes: number;
  primitives: number;
  skins: number;
  joints: number;
}

function counts(doc: Document): Counts {
  const root = doc.getRoot();
  return {
    nodes: root.listNodes().length,
    meshes: root.listMeshes().length,
    primitives: root.listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0),
    skins: root.listSkins().length,
    joints: root.listSkins().reduce((n, s) => n + s.listJoints().length, 0),
  };
}

export function sceneBounds(doc: Document): { min: number[]; max: number[] } {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) throw new ImportError('document has no scene');
  return getBounds(scene);
}

// ---------------------------------------------------------------------------
// Skin validation (skill: name the mesh and joint, never a stack trace)
// ---------------------------------------------------------------------------

function validateAndRepairSkins(doc: Document, label: string, notes: CanonNote[]): void {
  const root = doc.getRoot();
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const joints = prim.getAttribute('JOINTS_0');
      const weights = prim.getAttribute('WEIGHTS_0');
      if (!joints && !weights) continue;
      if (!joints || !weights) {
        throw new ImportError(
          `${label}: mesh "${mesh.getName()}" has ${joints ? 'JOINTS_0' : 'WEIGHTS_0'} ` +
            `without its counterpart`,
        );
      }
      const node = root.listNodes().find((n) => n.getMesh() === mesh);
      const skin = node?.getSkin();
      if (!skin) {
        throw new ImportError(
          `${label}: mesh "${mesh.getName()}" has skin attributes but no skin is bound`,
        );
      }
      const jointCount = skin.listJoints().length;
      const ibm = skin.getInverseBindMatrices();
      if (!ibm) {
        throw new ImportError(
          `${label}: skin "${skin.getName()}" on mesh "${mesh.getName()}" is missing ` +
            `inverse bind matrices`,
        );
      }
      const ibmArray = ibm.getArray()!;
      for (let i = 0; i < ibmArray.length; i++) {
        if (!Number.isFinite(ibmArray[i])) {
          throw new ImportError(
            `${label}: skin "${skin.getName()}" joint ${Math.floor(i / 16)} ` +
              `("${skin.listJoints()[Math.floor(i / 16)]?.getName()}") has a non-finite ` +
              `inverse bind matrix`,
          );
        }
      }

      const jArr = joints.getArray()!;
      for (let i = 0; i < jArr.length; i++) {
        if (jArr[i] >= jointCount) {
          throw new ImportError(
            `${label}: mesh "${mesh.getName()}" vertex ${Math.floor(i / 4)} references ` +
              `joint index ${jArr[i]} but skin "${skin.getName()}" has only ${jointCount} joints`,
          );
        }
      }

      // renormalize sloppy weights (generators are sloppy — skill)
      const wArr = weights.getArray()! as Float32Array<ArrayBuffer>;
      let repaired = 0;
      for (let v = 0; v < wArr.length; v += 4) {
        const sum = wArr[v] + wArr[v + 1] + wArr[v + 2] + wArr[v + 3];
        if (sum > 1e-6 && Math.abs(sum - 1) > 1e-3) {
          for (let k = 0; k < 4; k++) wArr[v + k] /= sum;
          repaired++;
        }
      }
      if (repaired > 0) {
        weights.setArray(wArr);
        notes.push({
          id: 'skin',
          status: 'warn',
          message: `Mesh "${mesh.getName()}": ${repaired} vertices had non-normalized weights`,
          fixApplied: 'weights renormalized to sum 1',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Skin-aware normalization (uniform scale + Y translation + optional 180° yaw)
// ---------------------------------------------------------------------------

function rootNodes(doc: Document): Node[] {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  return scene ? scene.listChildren() : [];
}

// column-major 4x4 helpers (local, tiny — no dependency)
type Mat4 = number[];

function mul4(a: ArrayLike<number>, b: ArrayLike<number>): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** N = T(0,ty,0) · Ry(180°?) · S(s)  and its exact inverse. */
function normalizationMatrices(s: number, ty: number, rotate: boolean): { n: Mat4; nInv: Mat4 } {
  const r = rotate ? -1 : 1;
  // dprint-ignore
  const n: Mat4 = [
    r * s,
    0,
    0,
    0,
    0,
    s,
    0,
    0,
    0,
    0,
    r * s,
    0,
    0,
    ty,
    0,
    1,
  ];
  // N⁻¹ = S(1/s) · Ry⁻¹ · T(0,-ty,0):
  // dprint-ignore
  const nInv: Mat4 = [
    r / s,
    0,
    0,
    0,
    0,
    1 / s,
    0,
    0,
    0,
    0,
    r / s,
    0,
    0,
    -ty / s,
    0,
    1,
  ];
  return { n, nInv };
}

/** Is this matrix the identity, to float tolerance? */
function isIdentityMat4(m: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) {
    if (Math.abs(m[i] - (i % 5 === 0 ? 1 : 0)) > 1e-6) return false;
  }
  return true;
}

/**
 * Bake N into the VERTEX DATA, returning false when that cannot be done safely.
 *
 * This is the fix for the defect the P3 exit measurement found. N used to live
 * only on the root node, and that is a promise the glTF spec lets a reader
 * ignore: **a skinned mesh node's transform is ignored, because the skin's
 * joints place it**. An unskinned canonical mesh is precisely the one that is
 * about to be rigged — so `rig` would add a skin, the `world` node carrying
 * scale and grounding would stop meaning anything, and the character silently
 * reverted to the backend's arbitrary size, feet below the floor. It reached a
 * 64 px sprite ~20 px tall whose own outline swallowed 81% of it.
 *
 * Refuses, leaving the node path to run, when:
 *   - a SKIN exists. Then N·root with IBM·N⁻¹ is exact and the joints carry it;
 *     baking vertices without re-deriving the bind pose would break the skin.
 *   - a mesh node is not at identity. Baking would give `local·N·v` where the
 *     node path gives `N·local·v`, and those differ unless they commute.
 *   - a primitive has morph targets, whose deltas take the rotation and scale
 *     but NOT the translation — a case with no fixture to prove it against.
 */
function bakeNormalizationIntoVertices(
  doc: Document,
  s: number,
  ty: number,
  rotate: boolean,
): boolean {
  if (doc.getRoot().listSkins().length > 0) return false;
  const meshNodes = doc.getRoot().listNodes().filter((node) => node.getMesh() !== null);
  if (meshNodes.some((node) => !isIdentityMat4(node.getWorldMatrix()))) return false;
  const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
  if (prims.some((p) => p.listTargets().length > 0)) return false;

  const r = rotate ? -1 : 1;
  // Accessors can be SHARED between primitives; transforming one twice would
  // square the scale on whatever they have in common.
  const done = new Set<unknown>();
  const apply = (
    prim: (typeof prims)[number],
    name: 'POSITION' | 'NORMAL' | 'TANGENT',
    fn: (v: Float32Array, i: number) => void,
  ) => {
    const acc = prim.getAttribute(name);
    if (!acc || done.has(acc)) return;
    done.add(acc);
    const arr = acc.getArray() as Float32Array<ArrayBuffer>;
    const stride = acc.getElementSize();
    for (let i = 0; i < arr.length; i += stride) fn(arr, i);
    acc.setArray(arr);
  };

  for (const prim of prims) {
    // N is a similarity: uniform scale s, optional 180° about Y (r = -1 flips
    // x and z), then a Y translation.
    apply(prim, 'POSITION', (v, i) => {
      v[i] = r * s * v[i];
      v[i + 1] = s * v[i + 1] + ty;
      v[i + 2] = r * s * v[i + 2];
    });
    // Directions take the rotation only — a positive uniform scale does not
    // change a normal's direction, and these stay unit length by construction.
    apply(prim, 'NORMAL', (v, i) => {
      v[i] = r * v[i];
      v[i + 2] = r * v[i + 2];
    });
    // TANGENT is vec4; w is the bitangent SIGN and must survive untouched.
    apply(prim, 'TANGENT', (v, i) => {
      v[i] = r * v[i];
      v[i + 2] = r * v[i + 2];
    });
  }
  return true;
}

/**
 * Apply normalization N to the scene.
 *
 * Preferred path: bake N into the vertex data, so the canonical mesh carries
 * its scale and grounding where nothing downstream is entitled to ignore them.
 * See `bakeNormalizationIntoVertices` for why a node transform was not enough.
 *
 * Fallback: root-node transforms become N·local and every inverse bind matrix
 * becomes IBM·N⁻¹, so world'·IBM' = I is preserved exactly. That is still the
 * only exact formulation for content that arrives already skinned, and it is
 * correct there because the joints sit under the root that receives N.
 */
function applyNormalization(doc: Document, s: number, ty: number, rotate: boolean): void {
  if (bakeNormalizationIntoVertices(doc, s, ty, rotate)) return;
  const { n, nInv } = normalizationMatrices(s, ty, rotate);
  for (const root of rootNodes(doc)) {
    const local = root.getMatrix();
    root.setMatrix(mul4(n, local) as unknown as typeof local);
  }
  for (const skin of doc.getRoot().listSkins()) {
    const ibmAcc = skin.getInverseBindMatrices();
    if (!ibmAcc) continue;
    const arr = ibmAcc.getArray()! as Float32Array<ArrayBuffer>;
    for (let j = 0; j < arr.length; j += 16) {
      const updated = mul4(arr.subarray(j, j + 16), nInv);
      arr.set(updated, j);
    }
    ibmAcc.setArray(arr);
  }
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

export async function canonicalize(
  doc: Document,
  opts: CanonicalizeOptions,
): Promise<CanonNote[]> {
  const notes: CanonNote[] = [];
  const before = counts(doc);

  // generate missing normals FIRST (recorded fix; tangents are deferred to
  // render prep via mikktspace — not fixed here)
  const missingNormals = doc.getRoot().listMeshes().some((m) =>
    m.listPrimitives().some((p) => !p.getAttribute('NORMAL'))
  );
  if (missingNormals) {
    await doc.transform(normals({ overwrite: false }));
    notes.push({
      id: 'normals',
      status: 'warn',
      message: 'Source had primitives without normals',
      fixApplied: 'flat normals generated',
    });
  }

  // supervised cleanup: keepLeaves protects joint leaf nodes from prune
  await doc.transform(
    resample(),
    prune({ keepLeaves: true, keepAttributes: true, keepIndices: true }),
    dedup(),
    weld(),
  );

  const after = counts(doc);
  for (const key of ['skins', 'joints', 'meshes'] as const) {
    if (after[key] !== before[key]) {
      throw new ImportError(
        `${opts.label}: canonicalization changed ${key} count ` +
          `${before[key]} -> ${after[key]} — failed import, not a cleanup (supervision law)`,
      );
    }
  }
  notes.push({
    id: 'cleanup',
    status: 'ok',
    message: `resample/prune/dedup/weld kept ${after.skins} skins / ${after.joints} joints / ` +
      `${after.meshes} meshes (${before.nodes} -> ${after.nodes} nodes)`,
  });

  validateAndRepairSkins(doc, opts.label, notes);

  // conventions: rotation (VRM 0.x), then measure, then scale + ground
  const rotate = opts.rotate180Y === true;
  const raw = sceneBounds(doc);
  const rawHeight = raw.max[1] - raw.min[1];
  if (!(rawHeight > 0)) {
    throw new ImportError(`${opts.label}: degenerate bounds (height ${rawHeight})`);
  }
  const s = opts.declaredHeightM ? opts.declaredHeightM / rawHeight : 1;
  // ground the feet AFTER scaling: minY * s must land at 0
  const ty = -(raw.min[1] * s);
  applyNormalization(doc, s, ty, rotate);

  const finalBounds = sceneBounds(doc);
  notes.push({
    id: 'orientation',
    status: 'ok',
    message: rotate
      ? 'VRM 0.x source rotated 180° to face +Z'
      : 'Source orientation kept (+Z forward assumed)',
    // NOT 'baked into geometry': applyNormalization writes the yaw onto the
    // scene's ROOT NODE matrices and leaves every vertex untouched. This
    // string rides into preflight.json and the warn stream, so a user reading
    // it would go looking for rotated vertices that do not exist.
    ...(rotate ? { fixApplied: '180° yaw applied to the root node transform' } : {}),
  });
  notes.push({
    id: 'scale',
    status: 'ok',
    message: `Raw height ${rawHeight.toFixed(4)} m; scaled x${s.toFixed(4)} to ` +
      `${(finalBounds.max[1] - finalBounds.min[1]).toFixed(4)} m, feet at Y=` +
      `${finalBounds.min[1].toFixed(5)}`,
    ...(s !== 1 || ty !== 0 ? { fixApplied: 'uniform rescale + feet grounded at Y=0' } : {}),
  });

  // strip volatile extras for byte determinism
  const root = doc.getRoot();
  root.setExtras({});
  for (
    const list of [
      root.listScenes(),
      root.listNodes(),
      root.listMeshes(),
      root.listSkins(),
      root.listMaterials(),
      root.listAccessors(),
      root.listBuffers(),
    ]
  ) {
    for (const prop of list) prop.setExtras({});
  }
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) prim.setExtras({});
  }

  return notes;
}
