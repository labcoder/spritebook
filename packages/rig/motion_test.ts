import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { motionSurfaceStats } from './dist/motion.js';
import type { RiggedAsset } from './skin.ts';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
test('real motion detects a wrong owner opening a duplicated surface seam, without flagging a rigid control', () => {
  const child = identity();
  child[12] = 1;
  const inverse = identity();
  inverse[12] = -1;
  const asset: RiggedAsset = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    joints: new Uint32Array(24),
    weights: Float32Array.from({ length: 24 }, (_, i) => i % 4 === 0 ? 1 : 0),
    vertexCount: 6,
    jointCount: 2,
    jointNames: ['root', 'hand'],
    jointParents: new Int32Array([-1, 0]),
    bindLocals: new Float32Array([...identity(), ...child]),
    inverseBind: new Float32Array([...identity(), ...inverse]),
  };
  const moved = identity();
  moved[12] = 3;
  const poses = {
    frames: 2,
    jointNames: ['root', 'hand'],
    data: new Float32Array([...identity(), ...child, ...identity(), ...moved]),
  };
  const clean = motionSurfaceStats(asset, poses);
  assert.equal(clean.worstStretchedFraction, 0);
  assert.equal(clean.maxSeparationM, 0);
  asset.joints[3 * 4] = 1;
  const damaged = motionSurfaceStats(asset, poses);
  assert(damaged.worstStretchedFraction > 0);
  assert.equal(damaged.maxSeparationM, 2);
  assert(damaged.reviewJoints.includes('hand'));
  poses.data[0] = NaN;
  assert.throws(() => motionSurfaceStats(asset, poses), /non-finite/);
});
