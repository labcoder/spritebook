// P0-T2: load the skinned glTF via glTF-Transform and evaluate joint matrices
// per frame (deterministic function of the frame index — no wall clock anywhere).

import { type Node, WebIO } from 'npm:@gltf-transform/core@4.2.1';
import {
  type Mat4,
  mat4Identity,
  mat4Multiply,
  mat4RotationY,
  mat4RotationZ,
  mat4Translation,
} from './math.ts';

export interface SpikeAsset {
  positions: Float32Array;
  normals: Float32Array;
  joints: Uint8Array;
  weights: Float32Array;
  indices: Uint16Array;
  jointCount: number;
  jointParents: Int32Array; // -1 = root; parents always precede children
  jointTranslations: Float32Array; // xyz per joint
  inverseBind: Float32Array; // jointCount * 16
}

export async function loadAsset(path: string | URL): Promise<SpikeAsset> {
  const doc = await new WebIO().readBinary(await Deno.readFile(path));
  const root = doc.getRoot();
  const prim = root.listMeshes()[0].listPrimitives()[0];
  const skin = root.listSkins()[0];
  const joints = skin.listJoints();

  const parentOf = new Map<Node, Node>();
  const walk = (n: Node) => {
    for (const c of n.listChildren()) {
      parentOf.set(c, n);
      walk(c);
    }
  };
  for (const scene of root.listScenes()) for (const n of scene.listChildren()) walk(n);

  const jointParents = new Int32Array(joints.length);
  const jointTranslations = new Float32Array(joints.length * 3);
  joints.forEach((j, i) => {
    const p = parentOf.get(j);
    jointParents[i] = p ? joints.indexOf(p) : -1;
    if (jointParents[i] >= i) throw new Error('joint order: parent must precede child');
    jointTranslations.set(j.getTranslation(), i * 3);
  });

  return {
    positions: prim.getAttribute('POSITION')!.getArray() as Float32Array,
    normals: prim.getAttribute('NORMAL')!.getArray() as Float32Array,
    joints: prim.getAttribute('JOINTS_0')!.getArray() as Uint8Array,
    weights: prim.getAttribute('WEIGHTS_0')!.getArray() as Float32Array,
    indices: prim.getIndices()!.getArray() as Uint16Array,
    jointCount: joints.length,
    jointParents,
    jointTranslations,
    inverseBind: skin.getInverseBindMatrices()!.getArray() as Float32Array,
  };
}

const scratchT: Mat4 = new Float32Array(16);
const scratchR: Mat4 = new Float32Array(16);
const scratchL: Mat4 = new Float32Array(16);

/** Skinning matrices for `frame` into `out` (jointCount*16). Deterministic per frame index. */
export function evalJointMatrices(
  asset: SpikeAsset,
  frame: number,
  out: Float32Array,
  worlds: Float32Array,
): void {
  for (let i = 0; i < asset.jointCount; i++) {
    const tx = asset.jointTranslations[i * 3];
    const ty = asset.jointTranslations[i * 3 + 1];
    const tz = asset.jointTranslations[i * 3 + 2];
    mat4Translation(tx, ty, tz, scratchT);
    // root turns like a turntable; children sway — exercises the whole chain
    if (i === 0) mat4RotationY(frame * 0.06, scratchR);
    else mat4RotationZ(0.45 * Math.sin(frame * 0.13 + i * 0.9), scratchR);
    mat4Multiply(scratchT, scratchR, scratchL);

    const world = worlds.subarray(i * 16, i * 16 + 16);
    const p = asset.jointParents[i];
    if (p < 0) world.set(scratchL);
    else mat4Multiply(worlds.subarray(p * 16, p * 16 + 16), scratchL, world);

    mat4Multiply(
      world,
      asset.inverseBind.subarray(i * 16, i * 16 + 16),
      out.subarray(i * 16, i * 16 + 16),
    );
  }
}

export function jointScratch(asset: SpikeAsset): { mats: Float32Array; worlds: Float32Array } {
  return {
    mats: new Float32Array(asset.jointCount * 16),
    worlds: new Float32Array(asset.jointCount * 16),
  };
}
