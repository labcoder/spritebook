import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { encode } from '@spritebook/image';
import { exportModel, runExportJob } from './dist/mod.js';

test('model-only export preserves GLB and texture bytes without a bake', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-model-export-'));
  try {
    const doc = new Document();
    const image = new Uint8Array(
      await encode({ width: 1, height: 1, data: new Uint8Array([40, 80, 120, 255]) }),
    );
    const texture = doc.createTexture('Character color').setImage(image).setMimeType('image/png');
    const buffer = doc.createBuffer();
    const positions = doc.createAccessor().setType('VEC3').setArray(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    ).setBuffer(buffer);
    const mesh = doc.createMesh().addPrimitive(
      doc.createPrimitive().setAttribute('POSITION', positions).setMaterial(
        doc.createMaterial().setBaseColorTexture(texture),
      ),
    );
    doc.createScene().addChild(doc.createNode().setMesh(mesh));
    const source = join(root, 'input.glb');
    const bytes = await new NodeIO().writeBinary(doc);
    await fs.writeFile(source, bytes);
    const out = join(root, 'export');
    const events = [];
    for await (
      const e of runExportJob({ jobId: 'export', modelPath: source, outDir: out, targets: [] })
    ) events.push(e);
    assert.equal(events.at(-1)?.t, 'done');
    assert.deepEqual(new Uint8Array(await fs.readFile(join(out, 'model/model.glb'))), bytes);
    assert.deepEqual(new Uint8Array(await fs.readFile(join(out, 'model/texture-00.png'))), image);
    assert.equal(
      JSON.parse(await fs.readFile(join(out, 'model/textures.json'), 'utf8')).textures[0].name,
      'Character color',
    );
    await assert.rejects(
      () => exportModel(join(out, 'model/model.glb'), join(out, 'model')),
      /overwrite/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
