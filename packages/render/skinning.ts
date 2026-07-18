/**
 * Load a canonical glb (importer-border output) into GPU-ready vertex streams +
 * a skeleton, and evaluate joint matrices per frame. Promoted from the P0-T2
 * spike and hardened: reads real bind-pose local matrices, upconverts JOINTS_0
 * to u32 (the frozen vertex layout), CONCATENATES every mesh and every primitive
 * (the importer preserves multi-primitive characters — body/clothes/hair — and a
 * character is almost always multi-material), and synthesizes a trivial 1-joint
 * skin for static meshes so the skinning pipeline is the only draw path.
 *
 * The per-frame pose is a DETERMINISTIC function of the frame index (no wall
 * clock) — a whole-body root turntable about +Y — so it exercises the full skin
 * chain while keeping the feet grounded, and the double-render canary stays
 * meaningful. Real ClipBinding sampling replaces `evalJointMatrices` when the
 * anim package lands.
 */
import { type Document, NodeIO } from '@gltf-transform/core';
import type { ModelBounds } from './contracts.ts';
import { type Mat4, mat4Identity, mat4Multiply, mat4RotationY } from './math.ts';

export interface SkinnedAsset {
  positions: Float32Array; // vec3 per vertex
  normals: Float32Array; // vec3 per vertex
  joints: Uint32Array; // 4 joint indices per vertex (upconverted)
  weights: Float32Array; // 4 weights per vertex
  indices: Uint32Array; // triangle list
  jointCount: number;
  /** joint node names, in skin joint order (poses files map onto these BY NAME) */
  jointNames: string[];
  /** bind-pose LOCAL matrix per joint (column-major, 16 floats each) */
  bindLocals: Float32Array;
  /** parent joint index, -1 for roots; parents always precede children */
  jointParents: Int32Array;
  /** inverse bind matrix per joint (16 floats each) */
  inverseBind: Float32Array;
  /** bind-pose bounds (canonical frame: feet on Y=0, scaled to declared height) */
  bounds: ModelBounds;
}

function toU32(src: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

function concatF32(parts: Float32Array[]): Float32Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function concatU32(parts: Uint32Array[]): Uint32Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function boundsOf(positions: Float32Array): ModelBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

export async function loadSkinnedAsset(path: string): Promise<SkinnedAsset> {
  const doc = await new NodeIO().readBinary(await Deno.readFile(path));
  return documentToAsset(doc, path);
}

/**
 * Build a render asset from a glTF-Transform Document. Split out from the file
 * reader so the concatenation path is unit-testable without a binary fixture.
 * Every primitive of every mesh is folded into one vertex/index stream (indices
 * offset per primitive); a primitive lacking JOINTS_0/WEIGHTS_0 is rigid-bound
 * to joint 0 (a prop that rides the root, or the lone identity joint of a static
 * mesh).
 */
export function documentToAsset(doc: Document, label: string): SkinnedAsset {
  const root = doc.getRoot();
  const meshes = root.listMeshes();
  if (meshes.length === 0) throw new Error(`${label}: no mesh to render`);

  const skins = root.listSkins();
  if (skins.length > 1) throw new Error(`${label}: multiple skins unsupported (P2-T1)`);
  const skin = skins[0];

  const posParts: Float32Array[] = [];
  const nrmParts: Float32Array[] = [];
  const jntParts: Uint32Array[] = [];
  const wgtParts: Float32Array[] = [];
  const idxParts: Uint32Array[] = [];
  let vertexBase = 0;

  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')!.getArray() as Float32Array;
      const vcount = pos.length / 3;
      posParts.push(pos);

      const nrmAcc = prim.getAttribute('NORMAL');
      if (!nrmAcc) {
        throw new Error(`${label}: primitive missing NORMAL (the importer generates them)`);
      }
      nrmParts.push(nrmAcc.getArray() as Float32Array);

      const jAcc = prim.getAttribute('JOINTS_0');
      const wAcc = prim.getAttribute('WEIGHTS_0');
      if (jAcc && wAcc) {
        jntParts.push(toU32(jAcc.getArray() as ArrayLike<number>));
        wgtParts.push(wAcc.getArray() as Float32Array);
      } else {
        // rigid-bind to joint 0: index 0, weight (1,0,0,0)
        const j = new Uint32Array(vcount * 4);
        const w = new Float32Array(vcount * 4);
        for (let i = 0; i < vcount; i++) w[i * 4] = 1;
        jntParts.push(j);
        wgtParts.push(w);
      }

      const iAcc = prim.getIndices();
      if (iAcc) {
        const src = iAcc.getArray() as ArrayLike<number>;
        const out = new Uint32Array(src.length);
        for (let i = 0; i < src.length; i++) out[i] = src[i] + vertexBase;
        idxParts.push(out);
      } else {
        const out = new Uint32Array(vcount);
        for (let i = 0; i < vcount; i++) out[i] = vertexBase + i;
        idxParts.push(out);
      }
      vertexBase += vcount;
    }
  }

  const positions = concatF32(posParts);
  const bounds = boundsOf(positions);
  const common = {
    positions,
    normals: concatF32(nrmParts),
    joints: concatU32(jntParts),
    weights: concatF32(wgtParts),
    indices: concatU32(idxParts),
    bounds,
  };

  if (!skin) {
    // static: one identity joint (every vertex was rigid-bound to it above)
    return {
      ...common,
      jointCount: 1,
      jointNames: ['<static>'],
      bindLocals: mat4Identity(),
      jointParents: Int32Array.of(-1),
      inverseBind: mat4Identity(),
    };
  }

  const jointNodes = skin.listJoints();
  const jointCount = jointNodes.length;
  const nodeIndex = new Map(jointNodes.map((n, i) => [n, i]));

  const parentOf = new Map<typeof jointNodes[number], typeof jointNodes[number]>();
  const walk = (n: typeof jointNodes[number]) => {
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
    const pi = p ? (nodeIndex.get(p) ?? -1) : -1;
    if (pi >= i) throw new Error(`${label}: joint order — parent must precede child`);
    jointParents[i] = pi;
  });

  return {
    ...common,
    jointCount,
    jointNames: jointNodes.map((j) => j.getName()),
    bindLocals,
    jointParents,
    inverseBind: skin.getInverseBindMatrices()!.getArray() as Float32Array,
  };
}

/**
 * Pose sources:
 *  - 'turntable': whole-body rotation about +Y (directions/goldens fixture pose).
 *  - 'idle': a gentle low-amplitude sway about +Y — the near-static loop the
 *    flicker metric needs. Frame 0 is the bind pose in both.
 *  - 'clip': play a poses artifact (P3-T1) — handled by evalPosesMatrices; it
 *    never reaches the test-pose driver below.
 */
export type PoseMode = 'turntable' | 'idle' | 'clip';

function rootAngle(pose: PoseMode, frame: number): number {
  if (pose === 'idle') return 0.03 * Math.sin(frame * 0.4);
  if (pose === 'clip') return 0; // unreachable via the renderer's clip branch
  return frame * 0.06;
}

export function jointScratch(asset: SkinnedAsset): { mats: Float32Array; worlds: Float32Array } {
  return {
    mats: new Float32Array(asset.jointCount * 16),
    worlds: new Float32Array(asset.jointCount * 16),
  };
}

const scratchDelta: Mat4 = new Float32Array(16);
const scratchLocal: Mat4 = new Float32Array(16);

/**
 * Skinning matrices (world * inverseBind) for `frame` into `out`. Deterministic
 * per frame index — the test pose is a whole-body turntable: the ROOT joint
 * rotates about +Y and every child rides at its bind local. Rotation about the
 * vertical through the feet keeps the feet plane on world Y=0 (so feet-baseline
 * framing stays exact) and, for an axis-centered character, keeps the silhouette
 * within the bind-pose bounds — while still changing every joint's world matrix
 * per frame, so the storage-buffer skin path is exercised. Frame 0 is the exact
 * bind pose. Real ClipBinding sampling replaces this when the anim package lands.
 */
export function evalJointMatrices(
  asset: SkinnedAsset,
  frame: number,
  out: Float32Array,
  worlds: Float32Array,
  pose: PoseMode = 'turntable',
): void {
  const angle = rootAngle(pose, frame);
  for (let i = 0; i < asset.jointCount; i++) {
    const bind = asset.bindLocals.subarray(i * 16, i * 16 + 16);
    // root rotates about Y (through the grounded feet); children ride at bind
    if (i === 0) mat4RotationY(angle, scratchDelta);
    else mat4Identity(scratchDelta);
    mat4Multiply(bind, scratchDelta, scratchLocal);

    const world = worlds.subarray(i * 16, i * 16 + 16);
    const p = asset.jointParents[i];
    if (p < 0) world.set(scratchLocal);
    else mat4Multiply(worlds.subarray(p * 16, p * 16 + 16), scratchLocal, world);

    mat4Multiply(
      world,
      asset.inverseBind.subarray(i * 16, i * 16 + 16),
      out.subarray(i * 16, i * 16 + 16),
    );
  }
}

/**
 * Skinning matrices for one poses-file frame: local matrices come from the
 * poses blob (mapped by name; unmapped joints play their bind locals), then the
 * same world/IBM composition as evalJointMatrices. `map` is
 * poses.mapPosesJoints's asset-index -> poses-index table.
 */
export function evalPosesMatrices(
  asset: SkinnedAsset,
  posesData: Float32Array,
  map: Int32Array,
  jointsPerFrame: number,
  frame: number,
  out: Float32Array,
  worlds: Float32Array,
): void {
  const base = frame * jointsPerFrame * 16;
  for (let i = 0; i < asset.jointCount; i++) {
    const pi = map[i];
    const local = pi >= 0
      ? posesData.subarray(base + pi * 16, base + pi * 16 + 16)
      : asset.bindLocals.subarray(i * 16, i * 16 + 16);

    const world = worlds.subarray(i * 16, i * 16 + 16);
    const p = asset.jointParents[i];
    if (p < 0) world.set(local);
    else mat4Multiply(worlds.subarray(p * 16, p * 16 + 16), local, world);

    mat4Multiply(
      world,
      asset.inverseBind.subarray(i * 16, i * 16 + 16),
      out.subarray(i * 16, i * 16 + 16),
    );
  }
}

/** posedBounds, but driven by a poses blob instead of the test-pose driver. */
export function posedBoundsFromPoses(
  asset: SkinnedAsset,
  posesData: Float32Array,
  map: Int32Array,
  jointsPerFrame: number,
  frames: number,
): ModelBounds {
  const mats = new Float32Array(asset.jointCount * 16);
  const worlds = new Float32Array(asset.jointCount * 16);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const { positions: p, joints: J, weights: W } = asset;
  const vcount = p.length / 3;

  for (let f = 0; f < Math.max(1, frames); f++) {
    evalPosesMatrices(asset, posesData, map, jointsPerFrame, f, mats, worlds);
    for (let v = 0; v < vcount; v++) {
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
      if (x < min[0]) min[0] = x;
      if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y;
      if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z;
      if (z > max[2]) max[2] = z;
    }
  }
  return { min, max };
}

/**
 * Union AABB of the SKINNED vertices over frames [0, frames) — the stable
 * per-clip bounds the framing solver must use so near/far bracketing and the
 * padding fit hold for the animated pose, not just the bind pose (a rotating or
 * moving silhouette sweeps outside the bind AABB). CPU mirror of the vertex
 * shader's skin blend; deterministic.
 */
export function posedBounds(
  asset: SkinnedAsset,
  frames: number,
  pose: PoseMode = 'turntable',
): ModelBounds {
  const mats = new Float32Array(asset.jointCount * 16);
  const worlds = new Float32Array(asset.jointCount * 16);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const { positions: p, joints: J, weights: W } = asset;
  const vcount = p.length / 3;
  const nf = Math.max(1, frames);

  for (let f = 0; f < nf; f++) {
    evalJointMatrices(asset, f, mats, worlds, pose);
    for (let v = 0; v < vcount; v++) {
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
      if (x < min[0]) min[0] = x;
      if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y;
      if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z;
      if (z > max[2]) max[2] = z;
    }
  }
  return { min, max };
}
