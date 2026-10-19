import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Sampling semantics + the poses artifact (integrator half of P3-T1):
 * frame-time laws from contracts.ts, TRS composition against rest, and the
 * CROSS-PACKAGE round-trip — anim writes, RENDER reads — which is the pin that
 * keeps the two ends of the poses seam from drifting.
 */
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { NodeIO } from '@gltf-transform/core';
import { mapPosesJoints, readPoses as renderReadPoses } from '../render/poses.ts';
import type { Clip } from './dist/contracts.js';
import { loadClip, loadSkeletonRest } from './dist/profile.js';
import { frameTimes, readPoses, sampleClip, writePoses } from './dist/sample.js';

const UAL = new URL('./fixtures/ual-subset.glb', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

test('frameTimes: loop is exclusive-end; holdLast lands on the end', () => {
  assertEquals(frameTimes(2, { frames: 4, speed: 1, holdLast: false }), [0, 0.5, 1, 1.5]);
  assertEquals(frameTimes(2, { frames: 3, speed: 1, holdLast: true }), [0, 1, 2]);
  assertEquals(frameTimes(1, { frames: 1, speed: 1, holdLast: true }), [0]);
});

test('sampleClip: untracked joints hold rest; tracked joints move; STEP steps', () => {
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

test('poses round-trip: anim writes, ANIM and RENDER read identical bytes', async () => {
  const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(UAL)));
  const rest = loadSkeletonRest(doc);
  const clip = loadClip(doc, 'Walk_Loop', 'walk-loop');
  const sampled = sampleClip(clip, rest, { frames: 6, speed: 1, holdLast: false });

  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
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
    assertEquals(new Uint8Array(await fs.readFile(path)), new Uint8Array(await fs.readFile(path2)));
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('frameTimes: speed does NOT shrink the sampling window', () => {
  // This replaces an assertion that `frameTimes(2, {frames:4, speed:2})` is
  // [0, 0.25, 0.5, 0.75] - i.e. that double speed samples only the FIRST HALF
  // of the clip. That locked the defect in as the contract: `walk-loop:6@0.5`
  // shipped 6 frames whose last 3 were byte-identical frozen poses (sampled
  // past the end and clamped), and `@2` shipped half a stride that snapped
  // back every loop, both reporting `frames` distinct frames with no warn.
  //
  // Speed is a playback RATE. It belongs in BakeManifest.clips[].fps
  // (frames / (durationS / speed)), so the whole animation plays in
  // duration/speed seconds - which is what double speed means. The samples
  // must therefore cover the whole cycle at every speed.
  const at = (speed: number) => frameTimes(2, { frames: 4, speed, holdLast: false });
  assertEquals(at(1), [0, 0.5, 1, 1.5]);
  assertEquals(at(2), at(1), 'double speed samples the same poses, played faster');
  assertEquals(at(0.5), at(1), 'half speed samples the same poses, played slower');

  // and no sample ever lands past the clip, which is what produced the frozen
  // duplicates: at speed 0.5 the old code asked for t = 2, 3, 4, 5 on a 2s clip
  for (const speed of [0.25, 0.5, 1, 2, 4]) {
    for (const t of frameTimes(2, { frames: 6, speed, holdLast: true })) {
      assert(t >= 0 && t <= 2, `speed ${speed}: sample ${t} is outside the clip`);
    }
  }
});
