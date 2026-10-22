import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NodeIO, VertexLayout } from '@gltf-transform/core';
import { addClipToDocument, type Clip } from '@spritebook/anim';
import { qAxisAngle, qConj, qFromMat4, qMul, qRotate } from '@spritebook/anim/quat';
import { boneDirection, DEFAULT_ANGLE_DEG, dominantPerpendicularAxis } from './deform.ts';
import { documentToRiggedAsset, restWorlds, type RiggedAsset } from './skin.ts';

/** The same ±30° bend as deformCheck, encoded as a playable core artifact. */
export function jointBendClip(asset: RiggedAsset, joint: string): Clip {
  const index = asset.jointNames.indexOf(joint);
  if (index < 0) throw new Error(`Unknown rig joint "${joint}". Select a joint from this rig.`);
  const rest = restWorlds(asset);
  const world = rest.subarray(index * 16, index * 16 + 16);
  const parent = asset.jointParents[index];
  const parentRotation = parent < 0
    ? [0, 0, 0, 1] as [number, number, number, number]
    : qFromMat4(rest.subarray(parent * 16, parent * 16 + 16));
  const axis = qRotate(qConj(parentRotation), dominantPerpendicularAxis(boneDirection(world)));
  const localRotation = qFromMat4(asset.bindLocals.subarray(index * 16, index * 16 + 16));
  const rotations = new Float32Array(20);
  [0, 1, 0, -1, 0].forEach((sign, key) => {
    rotations.set(
      qMul(qAxisAngle(axis, sign * DEFAULT_ANGLE_DEG * Math.PI / 180), localRotation),
      key * 4,
    );
  });
  return {
    id: 'deform-check',
    duration: 4,
    tracks: new Map([[joint, {
      times: new Float32Array([0, 1, 2, 3, 4]),
      rotations,
      interpolation: 'LINEAR',
    }]]),
  };
}

/** Derived preview only: never overwrites the rig or changes its acceptance. */
export async function writeDeformPreview(
  riggedPath: string,
  joint: string,
  outPath: string,
): Promise<void> {
  const key = (p: string) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  if (key(riggedPath) === key(outPath)) {
    throw new Error('The preview must have its own output path.');
  }
  const io = new NodeIO().setVertexLayout(VertexLayout.SEPARATE);
  const doc = await io.readBinary(new Uint8Array(await fs.readFile(riggedPath)));
  const clip = jointBendClip(documentToRiggedAsset(doc, riggedPath), joint);
  for (const animation of doc.getRoot().listAnimations()) animation.dispose();
  addClipToDocument(doc, clip, clip.id);
  const temporary = `${outPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, await io.writeBinary(doc), { flag: 'wx' });
    await fs.rename(temporary, outPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
