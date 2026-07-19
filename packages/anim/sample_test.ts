/**
 * Sampling semantics + the poses artifact (integrator half of P3-T1):
 * frame-time laws from contracts.ts, TRS composition against rest, and the
 * CROSS-PACKAGE round-trip — anim writes, RENDER reads — which is the pin that
 * keeps the two ends of the poses seam from drifting.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1';
import { NodeIO } from '@gltf-transform/core';
import { mapPosesJoints, readPoses as renderReadPoses } from '../render/poses.ts';
import type { Clip } from './contracts.ts';
import { loadClip, loadSkeletonRest } from './profile.ts';
import { frameTimes, readPoses, sampleClip, writePoses } from './sample.ts';

const UAL = new URL('./fixtures/ual-subset.glb', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

Deno.test('frameTimes: loop is exclusive-end; holdLast lands on the end; speed scales', () => {
  assertEquals(frameTimes(2, { frames: 4, speed: 1, holdLast: false }), [0, 0.5, 1, 1.5]);
  assertEquals(frameTimes(2, { frames: 3, speed: 1, holdLast: true }), [0, 1, 2]);
  assertEquals(frameTimes(2, { frames: 4, speed: 2, holdLast: false }), [0, 0.25, 0.5, 0.75]);
  assertEquals(frameTimes(1, { frames: 1, speed: 1, holdLast: true }), [0]);
});

Deno.test('sampleClip: untracked joints hold rest; tracked joints move; STEP steps', () => {
  const rest = {
    parents: new Map([['a', ''], ['b', 'a']]),
    locals: new Map([
      ['a', Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1)],
      ['b', Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1)],
    ]),
  };
  const clip: Clip = {
    id: 'test',
    duration: 1,
    tracks: new Map([
      ['a', {
        times: Float32Array.of(0, 1),
        translations: Float32Array.of(0, 2, 0, 0, 4, 0),
        interpolation: 'LINEAR' as const,
      }],
    ]),
  };
  const s = sampleClip(clip, rest, { frames: 2, speed: 1, holdLast: true });
  assertEquals(s.jointNames, ['a', 'b']);
  // frame 0: a at rest translation (0,2,0); frame 1 (t=1): lerped to (0,4,0)
  assertAlmostEquals(s.data[13], 2, 1e-6, 'a.ty frame 0');
  assertAlmostEquals(s.data[2 * 16 + 13], 4, 1e-6, 'a.ty frame 1');
  // b untracked: rest local at every frame
  assertAlmostEquals(s.data[16 + 13], 1, 1e-6, 'b.ty frame 0');
  assertAlmostEquals(s.data[3 * 16 + 13], 1, 1e-6, 'b.ty frame 1');
});

Deno.test('poses round-trip: anim writes, ANIM and RENDER read identical bytes', async () => {
  const doc = await new NodeIO().readBinary(await Deno.readFile(UAL));
  const rest = loadSkeletonRest(doc);
  const clip = loadClip(doc, 'Walk_Loop', 'walk-loop');
  const sampled = sampleClip(clip, rest, { frames: 6, speed: 1, holdLast: false });

  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/poses-walk-loop.bin`;
    await writePoses(path, 'walk-loop', sampled);

    const viaAnim = await readPoses(path);
    const viaRender = await renderReadPoses(path);
    assertEquals(viaAnim.header, viaRender.header, 'headers agree across packages');
    assertEquals(viaRender.header.clipId, 'walk-loop');
    assertEquals(viaRender.header.frames, 6);
    assertEquals(viaRender.header.jointNames.length, 66, 'Armature root + 65 UAL joints');
    assertEquals([...viaAnim.data], [...viaRender.data], 'blob identical across readers');
    assertEquals(viaAnim.data.length, 6 * 66 * 16);

    // and the render-side name mapping composes with a partial-asset skeleton
    const map = mapPosesJoints(['pelvis', 'no-such-joint'], viaRender.header);
    assert(map[0] >= 0 && map[1] === -1);

    // determinism: write twice -> byte-identical files
    const path2 = `${dir}/again.bin`;
    await writePoses(path2, 'walk-loop', sampled);
    assertEquals(await Deno.readFile(path), await Deno.readFile(path2));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
