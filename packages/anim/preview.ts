import { promises as fs } from 'node:fs';
/**
 * Preview-clip emission (D-006 retarget-once): write a retargeted Clip back
 * into the TARGET model's glTF as a single animation, producing the GLB the
 * GUI will play. The preview and the bake consume the SAME retargeted clip —
 * the parity acceptance samples this GLB's tracks and compares joint locals
 * against the poses file, frame for frame.
 */
import { type Document, NodeIO, VertexLayout } from '@gltf-transform/core';
import type { Clip } from './contracts.ts';

/** Add `clip` as an animation named `name` on the target document's nodes. */
export function addClipToDocument(doc: Document, clip: Clip, name: string): void {
  const nodesByName = new Map(doc.getRoot().listNodes().map((n) => [n.getName(), n]));
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const anim = doc.createAnimation(name);

  for (const [joint, track] of clip.tracks) {
    const node = nodesByName.get(joint);
    if (!node) continue; // unmapped joints were already reported by retarget
    const input = doc.createAccessor().setType('SCALAR')
      .setArray(track.times as Float32Array<ArrayBuffer>).setBuffer(buffer);
    const add = (
      path: 'translation' | 'rotation' | 'scale',
      values: Float32Array,
      type: 'VEC3' | 'VEC4',
    ) => {
      const output = doc.createAccessor().setType(type)
        .setArray(values as Float32Array<ArrayBuffer>).setBuffer(buffer);
      const sampler = doc.createAnimationSampler()
        .setInput(input)
        .setOutput(output)
        .setInterpolation(track.interpolation);
      const channel = doc.createAnimationChannel()
        .setTargetNode(node)
        .setTargetPath(path)
        .setSampler(sampler);
      anim.addSampler(sampler).addChannel(channel);
    };
    if (track.rotations) add('rotation', track.rotations, 'VEC4');
    if (track.translations) add('translation', track.translations, 'VEC3');
    if (track.scales) add('scale', track.scales, 'VEC3');
  }
}

/** Emit the preview GLB: the target model + the retargeted clip as `clipId`. */
export async function writePreviewGlb(
  targetModelPath: string,
  clip: Clip,
  outPath: string,
): Promise<void> {
  // SEPARATE, not gltf-transform's default interleaved layout (W4c): the
  // studio viewport's three.js WebGPU backend derives vertex formats from
  // interleaved mixed-type buffers that WebGPU does not have ('unorm32x4'),
  // and the canvas renders NOTHING while the transport plays. Every other
  // glb writer in the repo emits plain per-attribute buffers and renders;
  // the preview must too.
  const io = new NodeIO().setVertexLayout(VertexLayout.SEPARATE);
  const doc = await io.readBinary(new Uint8Array(await fs.readFile(targetModelPath)));
  addClipToDocument(doc, clip, clip.id);
  await fs.writeFile(outPath, await io.writeBinary(doc));
}
