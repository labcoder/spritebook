import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * W5b: the thumbnail is core output through the real render pipeline, so it
 * is GPU-gated like every render test - and the skip says it asserted
 * NOTHING rather than printing a hollow ok.
 */
import { assert, assertEquals } from '@std/assert';
import { decode as decodePng } from 'fast-png';
import { tryGetGpu } from '@spritebook/render';
import { writeResultThumb } from './dist/thumb.js';
import { Document, NodeIO } from '@gltf-transform/core';

const MODEL = new URL('../anim/fixtures/humanoid-normal.glb', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');

test('writeResultThumb: a front-view lit png with a real subject', async (t) => {
  if ((await tryGetGpu()) === null) {
    t.skip('No WebGPU adapter');
    return;
  }
  const tmp = await fs.mkdtemp(join(tmpdir(), 'sb-thumbtest-'));
  try {
    const out = `${tmp}/thumb.png`;
    assertEquals(await writeResultThumb(MODEL, out), 'written');
    const img = decodePng(new Uint8Array(await fs.readFile(out)));
    assertEquals([img.width, img.height], [192, 192]);
    const data = img.data as Uint8Array;
    let on = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) on++;
    const cov = on / (img.width * img.height);
    assert(cov > 0.05, `the subject fills the thumb (coverage ${(cov * 100).toFixed(1)}%)`);
  } finally {
    await fs.rm(tmp, { recursive: true }).catch(() => {});
  }
});

test('writeResultThumb: a broad subject retains its silhouette inside the card', async (t) => {
  if ((await tryGetGpu()) === null) {
    t.skip('No WebGPU adapter');
    return;
  }
  const tmp = await fs.mkdtemp(join(tmpdir(), 'sb-thumb-wide-'));
  try {
    const doc = new Document(), buffer = doc.createBuffer();
    const primitive = doc.createPrimitive()
      .setAttribute(
        'POSITION',
        doc.createAccessor().setType('VEC3').setBuffer(buffer)
          .setArray(new Float32Array([-3, 0, 0, 3, 0, 0, 3, 1, 0, -3, 1, 0])),
      )
      .setAttribute(
        'NORMAL',
        doc.createAccessor().setType('VEC3').setBuffer(buffer)
          .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])),
      )
      .setIndices(
        doc.createAccessor().setType('SCALAR').setBuffer(buffer)
          .setArray(new Uint16Array([0, 1, 2, 0, 2, 3])),
      )
      .setMaterial(doc.createMaterial().setDoubleSided(true));
    doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
    const model = join(tmp, 'wide.glb'), out = join(tmp, 'thumb.png');
    await new NodeIO().write(model, doc);
    assertEquals(await writeResultThumb(model, out), 'written');
    const image = decodePng(new Uint8Array(await fs.readFile(out)));
    let left = image.width, right = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (image.data[(y * image.width + x) * 4 + 3] > 0) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          assert(y >= 10 && y < image.height - 10, 'Keep vertical breathing room');
        }
      }
    }
    assert(left >= 10 && right < image.width - 10, 'Wide geometry must not touch the card edges');
    assert(right - left >= 160, 'The complete subject should fill the available width');
  } finally {
    await fs.rm(tmp, { recursive: true }).catch(() => {});
  }
});

test('writeResultThumb: a missing model fails soft, never throws', async (t) => {
  if ((await tryGetGpu()) === null) {
    t.skip('No WebGPU adapter');
    return;
  }
  const tmp = await fs.mkdtemp(join(tmpdir(), 'sb-thumbtest-'));
  try {
    assertEquals(await writeResultThumb(`${tmp}/absent.glb`, `${tmp}/t.png`), 'failed');
  } finally {
    await fs.rm(tmp, { recursive: true }).catch(() => {});
  }
});
