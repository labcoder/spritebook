import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { assert, assertAlmostEquals, assertEquals, assertRejects } from '@std/assert';
import { NodeIO } from '@gltf-transform/core';
import { loadClip, loadSkeletonRest, sampleClip } from '@spritebook/anim';
import { applyRig } from './dist/apply.js';
import { chainSkeleton, stageCase } from './dist/_fixtures.js';
import { writeDeformPreview } from './dist/preview.js';
import { boneDirection, dominantPerpendicularAxis } from './dist/deform.js';
import { documentToRiggedAsset, restWorlds, skinAll, skinMatrices } from './dist/skin.js';
import { runCli } from '../cli/dist/mod.js';

test('CLI bend preview preserves the rig and plays the measured pose through a rotated parent', async () => {
  const skeleton = chainSkeleton();
  skeleton.joints[0].tail = [.3, .75, .2];
  const c = await stageCase(skeleton);
  try {
    await applyRig(c);
    await fs.mkdir(`${c.dir}/canonical`);
    await fs.mkdir(`${c.dir}/rig`);
    const source = await fs.readFile(c.outPath);
    await fs.writeFile(`${c.dir}/canonical/model.glb`, source);
    const lines: string[] = [];
    assertEquals(
      await runCli(['rig', '--workspace', c.dir, '--preview-joint', 'bone_1', '--json'], {
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(line),
      }),
      0,
      lines.join('\n'),
    );
    assertEquals(await fs.readFile(`${c.dir}/canonical/model.glb`), source);
    const doc = await new NodeIO().readBinary(
      new Uint8Array(await fs.readFile(`${c.dir}/rig/deform-preview.glb`)),
    );
    const asset = documentToRiggedAsset(doc, 'preview');
    const clip = loadClip(doc, 'deform-check', 'deform-check');
    const poses = sampleClip(clip, loadSkeletonRest(doc), { frames: 5, speed: 1, holdLast: true });
    const axis = dominantPerpendicularAxis(boneDirection(restWorlds(asset).subarray(16, 32)));
    assertEquals(doc.getRoot().listAnimations().length, 1);
    for (const [frame, sign] of [[1, 1], [3, -1]]) {
      const locals = new Float32Array(asset.bindLocals);
      for (let i = 0; i < asset.jointCount; i++) {
        const p = poses.jointNames.indexOf(asset.jointNames[i]);
        locals.set(
          poses.data.subarray(
            (frame * poses.jointNames.length + p) * 16,
            (frame * poses.jointNames.length + p + 1) * 16,
          ),
          i * 16,
        );
      }
      const worlds = restWorlds({ ...asset, bindLocals: locals });
      const positions = skinAll(asset, skinMatrices(worlds, asset.inverseBind, asset.jointCount));
      // Ring four is 25 cm above the pivot, rigidly weighted to this joint.
      const v = [.1, .25, 0];
      const cross = [-axis[2] * v[1], axis[2] * v[0], axis[0] * v[1] - axis[1] * v[0]];
      const dot = axis[0] * v[0] + axis[1] * v[1];
      for (let k = 0; k < 3; k++) {
        const expected = (k === 1 ? .75 : 0) + v[k] * Math.cos(Math.PI / 6) +
          sign * cross[k] * Math.sin(Math.PI / 6) + axis[k] * dot * (1 - Math.cos(Math.PI / 6));
        assertAlmostEquals(positions[16 * 3 + k], expected, 1e-5);
      }
      assertAlmostEquals(positions[1], 0, 1e-5, 'the parent stays at rest');
      assert(
        Math.hypot(positions[24 * 3] - .1, positions[24 * 3 + 1] - 1.5, positions[24 * 3 + 2]) > .3,
        'the child follows the bend',
      );
    }
    await assertRejects(
      () => writeDeformPreview(c.outPath, 'missing-joint', `${c.dir}/bad.glb`),
      Error,
      'Unknown rig joint',
    );
    await assertRejects(
      () => writeDeformPreview(c.outPath, 'bone_1', c.outPath),
      Error,
      'own output path',
    );
    assertEquals(await fs.readFile(c.outPath), source);
  } finally {
    await fs.rm(c.dir, { recursive: true });
  }
});
