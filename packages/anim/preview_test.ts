/**
 * THE PARITY ACCEPTANCE (P3-T1): the preview GLB plays identically to what the
 * bake renders. Proof: retarget the real UAL walk onto a fixture body, emit the
 * preview GLB, load it back with the SAME loadClip the bake path uses, sample
 * both clips at the same binding times, and compare every joint local matrix.
 * Same sampled matrices in, same poses out — by construction, asserted anyway.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1';
import { NodeIO } from '@gltf-transform/core';
import { loadClip, loadSkeletonRest } from './profile.ts';
import { UAL_HUMANOID } from './profile.ts';
import { retargetClip } from './retarget.ts';
import { sampleClip } from './sample.ts';
import { writePreviewGlb } from './preview.ts';

const win = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const UAL = win(new URL('./fixtures/ual-subset.glb', import.meta.url));
const TARGET = win(new URL('./fixtures/humanoid-normal.glb', import.meta.url));

Deno.test('parity: preview GLB samples identically to the bake poses', async () => {
  const io = new NodeIO();
  const sourceDoc = await io.readBinary(await Deno.readFile(UAL));
  const targetDoc = await io.readBinary(await Deno.readFile(TARGET));

  const source = loadClip(sourceDoc, 'Walk_Loop', 'walk-loop');
  const sourceRest = loadSkeletonRest(sourceDoc);
  const targetRest = loadSkeletonRest(targetDoc);
  const { clip } = retargetClip(source, sourceRest, targetRest, UAL_HUMANOID);

  const spec = { frames: 6, speed: 1, holdLast: false };
  const bakeSide = sampleClip(clip, targetRest, spec);

  const dir = await Deno.makeTempDir();
  try {
    const previewPath = `${dir}/preview.glb`;
    await writePreviewGlb(TARGET, clip, previewPath);

    // play the preview exactly as a consumer would: load its animation back
    const previewDoc = await io.readBinary(await Deno.readFile(previewPath));
    const previewClip = loadClip(previewDoc, 'walk-loop', 'walk-loop');
    const previewRest = loadSkeletonRest(previewDoc);
    const previewSide = sampleClip(previewClip, previewRest, spec);

    assertEquals(previewSide.jointNames, bakeSide.jointNames, 'same skeleton order');
    assertEquals(previewSide.frames, bakeSide.frames);
    let maxErr = 0;
    for (let i = 0; i < bakeSide.data.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(bakeSide.data[i] - previewSide.data[i]));
    }
    assert(maxErr < 1e-5, `preview/bake joint locals diverge (max |err| ${maxErr})`);
    assertAlmostEquals(previewClip.duration, clip.duration, 1e-5);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
