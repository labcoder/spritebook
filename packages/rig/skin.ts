import { promises as fs } from 'node:fs';
/**
 * CPU linear-blend skinning and the rest-skeleton reader the deform check runs
 * on (P3-T3).
 *
 * This is a deliberate CPU MIRROR of `packages/render/skinning.ts` — same
 * column-major mat4 convention, same `world = parentWorld · local` chain, same
 * `skinMatrix = world · inverseBind`, same four-influence blend, same
 * concatenation order over every mesh and every primitive. It is duplicated
 * rather than imported because `@spritebook/render`'s public surface is the
 * D-004 render seam (a job that takes a GPU device); reaching into it for a
 * dozen lines of matrix algebra would make a headless deform check depend on
 * WebGPU. The conventions are what must agree, and they are asserted: the rest
 * round-trip test skins the bind pose here and lands back on the authored
 * vertex positions, which is only true if this blend and the writer's inverse
 * bind matrices agree with what the renderer will do on the GPU.
 *
 * Like the renderer, joint world matrices compose over the SKIN's joint list
 * only: an ancestor node that is not itself a joint contributes nothing (glTF
 * likewise ignores the skinned mesh node's own transform).
 */
import { type Document, NodeIO } from '@gltf-transform/core';

/** Column-major 4x4, 16 floats — the house convention (render/math.ts, glTF). */
export type Mat4 = Float32Array;

export interface RiggedAsset {
  /** rest (bind-pose) positions, xyz per vertex, primitives concatenated */
  positions: Float32Array;
  /** 4 joint indices per vertex, upconverted from u8/u16 */
  joints: Uint32Array;
  /** 4 weights per vertex */
  weights: Float32Array;
  /** triangle list into `positions`, offset per primitive */
  indices: Uint32Array;
  vertexCount: number;
  jointCount: number;
  /** joint node names, in skin joint order */
  jointNames: string[];
  /** parent joint index, -1 for a root; parents always precede children */
  jointParents: Int32Array;
  /** bind-pose LOCAL matrix per joint (16 floats each) */
  bindLocals: Float32Array;
  /** inverse bind matrix per joint (16 floats each) */
  inverseBind: Float32Array;
}

// ---------------------------------------------------------------------------
// mat4 (column-major; local and tiny, like importer/canonicalize.ts's mul4)
// ---------------------------------------------------------------------------

/** out = a · b (apply b first, then a) — matches render/math.ts mat4Multiply. */
export function mat4Multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: Mat4): Mat4 {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/**
 * Inverse of a RIGID transform (rotation + translation, unit scale): R⁻¹ = Rᵀ,
 * so the inverse is exact rather than a general solve. `applyRig` builds joint
 * world matrices this way on purpose — an inverse bind matrix that is the exact
 * transpose is the difference between a rest round-trip landing at 1e-7 and one
 * drifting at 1e-4 on a deep chain.
 */
export function mat4InvertRigid(m: ArrayLike<number>, out?: Mat4): Mat4 {
  const o = out ?? new Float32Array(16);
  o[0] = m[0], o[1] = m[4], o[2] = m[8], o[3] = 0;
  o[4] = m[1], o[5] = m[5], o[6] = m[9], o[7] = 0;
  o[8] = m[2], o[9] = m[6], o[10] = m[10], o[11] = 0;
  o[12] = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
  o[13] = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
  o[14] = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
  o[15] = 1;
  return o;
}

// ---------------------------------------------------------------------------
// Skeleton evaluation
// ---------------------------------------------------------------------------

/** World rest matrices per joint, from the bind locals down the parent chain. */
export function restWorlds(asset: RiggedAsset, out?: Float32Array): Float32Array {
  const worlds = out ?? new Float32Array(asset.jointCount * 16);
  for (let i = 0; i < asset.jointCount; i++) {
    const local = asset.bindLocals.subarray(i * 16, i * 16 + 16);
    const world = worlds.subarray(i * 16, i * 16 + 16);
    const p = asset.jointParents[i];
    if (p < 0) world.set(local);
    else mat4Multiply(worlds.subarray(p * 16, p * 16 + 16), local, world);
  }
  return worlds;
}

/** skinMatrix_i = world_i · inverseBind_i — the renderer's exact composition. */
export function skinMatrices(
  worlds: Float32Array,
  inverseBind: Float32Array,
  jointCount: number,
  out?: Float32Array,
): Float32Array {
  const mats = out ?? new Float32Array(jointCount * 16);
  for (let i = 0; i < jointCount; i++) {
    mat4Multiply(
      worlds.subarray(i * 16, i * 16 + 16),
      inverseBind.subarray(i * 16, i * 16 + 16),
      mats.subarray(i * 16, i * 16 + 16),
    );
  }
  return mats;
}

/**
 * Skin one vertex with the four-influence blend the vertex shader runs
 * (zero-weight slots skipped, exactly as in render/skinning.ts's CPU mirror).
 */
export function skinVertex(
  asset: RiggedAsset,
  mats: Float32Array,
  v: number,
  out: [number, number, number],
): [number, number, number] {
  const { positions: p, joints: J, weights: W } = asset;
  const px = p[v * 3], py = p[v * 3 + 1], pz = p[v * 3 + 2];
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < 4; k++) {
    const wgt = W[v * 4 + k];
    if (wgt === 0) continue;
    const j = J[v * 4 + k] * 16;
    x += wgt * (mats[j] * px + mats[j + 4] * py + mats[j + 8] * pz + mats[j + 12]);
    y += wgt * (mats[j + 1] * px + mats[j + 5] * py + mats[j + 9] * pz + mats[j + 13]);
    z += wgt * (mats[j + 2] * px + mats[j + 6] * py + mats[j + 10] * pz + mats[j + 14]);
  }
  out[0] = x, out[1] = y, out[2] = z;
  return out;
}

/** Every vertex skinned by `mats`, as a fresh xyz array. */
export function skinAll(asset: RiggedAsset, mats: Float32Array): Float32Array {
  const out = new Float32Array(asset.vertexCount * 3);
  const p: [number, number, number] = [0, 0, 0];
  for (let v = 0; v < asset.vertexCount; v++) {
    skinVertex(asset, mats, v, p);
    out[v * 3] = p[0], out[v * 3 + 1] = p[1], out[v * 3 + 2] = p[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function concat<T extends Float32Array | Uint32Array>(
  parts: T[],
  make: (n: number) => T,
): T {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = make(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Read a rigged glb into flat CPU arrays. Exactly one skin is required — a
 * Track B rig is one skeleton over one character, and a second skin would make
 * "joint 7" ambiguous in every number this package reports.
 */
export function documentToRiggedAsset(doc: Document, label: string): RiggedAsset {
  const root = doc.getRoot();
  const skins = root.listSkins();
  if (skins.length === 0) throw new Error(`${label}: no skin — is this the rigged glb?`);
  if (skins.length > 1) throw new Error(`${label}: ${skins.length} skins, expected exactly 1`);
  const skin = skins[0];

  const posParts: Float32Array[] = [];
  const jntParts: Uint32Array[] = [];
  const wgtParts: Float32Array[] = [];
  const idxParts: Uint32Array[] = [];
  let base = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) throw new Error(`${label}: mesh "${mesh.getName()}" primitive has no POSITION`);
      const positions = pos.getArray() as Float32Array;
      const vcount = positions.length / 3;
      posParts.push(positions);

      const jAcc = prim.getAttribute('JOINTS_0');
      const wAcc = prim.getAttribute('WEIGHTS_0');
      if (!jAcc || !wAcc) {
        throw new Error(
          `${label}: mesh "${mesh.getName()}" primitive is missing ` +
            `${jAcc ? 'WEIGHTS_0' : 'JOINTS_0'}`,
        );
      }
      const src = jAcc.getArray() as ArrayLike<number>;
      const j = new Uint32Array(src.length);
      for (let i = 0; i < src.length; i++) j[i] = src[i];
      jntParts.push(j);
      wgtParts.push(wAcc.getArray() as Float32Array);

      const iAcc = prim.getIndices();
      if (iAcc) {
        const si = iAcc.getArray() as ArrayLike<number>;
        const out = new Uint32Array(si.length);
        for (let i = 0; i < si.length; i++) out[i] = si[i] + base;
        idxParts.push(out);
      } else {
        const out = new Uint32Array(vcount);
        for (let i = 0; i < vcount; i++) out[i] = base + i;
        idxParts.push(out);
      }
      base += vcount;
    }
  }
  if (base === 0) throw new Error(`${label}: no mesh geometry`);

  const jointNodes = skin.listJoints();
  const jointCount = jointNodes.length;
  const index = new Map(jointNodes.map((n, i) => [n, i]));
  const parentOf = new Map<(typeof jointNodes)[number], (typeof jointNodes)[number]>();
  const walk = (n: (typeof jointNodes)[number]) => {
    for (const c of n.listChildren()) {
      parentOf.set(c, n);
      walk(c);
    }
  };
  for (const scene of root.listScenes()) for (const n of scene.listChildren()) walk(n);

  const bindLocals = new Float32Array(jointCount * 16);
  const jointParents = new Int32Array(jointCount);
  jointNodes.forEach((j, i) => {
    bindLocals.set(j.getMatrix() as number[], i * 16);
    const p = parentOf.get(j);
    const pi = p ? (index.get(p) ?? -1) : -1;
    if (pi >= i) throw new Error(`${label}: joint order — parent must precede child`);
    jointParents[i] = pi;
  });

  const ibmAcc = skin.getInverseBindMatrices();
  if (!ibmAcc) throw new Error(`${label}: skin "${skin.getName()}" has no inverse bind matrices`);

  const joints = concat(jntParts, (n) => new Uint32Array(n));
  // defensive: this loader is pointed at whatever glb a caller names, and an
  // out-of-range index would index past the skin matrix array instead of
  // failing — the same check the importer border runs, with the same message
  for (let i = 0; i < joints.length; i++) {
    if (joints[i] >= jointCount) {
      throw new Error(
        `${label}: vertex ${Math.floor(i / 4)} references joint index ${joints[i]} but the ` +
          `skin has only ${jointCount} joints`,
      );
    }
  }

  return {
    positions: concat(posParts, (n) => new Float32Array(n)),
    joints,
    weights: concat(wgtParts, (n) => new Float32Array(n)),
    indices: concat(idxParts, (n) => new Uint32Array(n)),
    vertexCount: base,
    jointCount,
    jointNames: jointNodes.map((j) => j.getName()),
    jointParents,
    bindLocals,
    inverseBind: ibmAcc.getArray() as Float32Array,
  };
}

/** documentToRiggedAsset over a glb on disk. */
export async function loadRiggedAsset(path: string): Promise<RiggedAsset> {
  const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(path)));
  return documentToRiggedAsset(doc, path);
}
