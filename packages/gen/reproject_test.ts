import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Reprojection is a projection, so it is testable EXACTLY: build a quad whose
 * world-to-UV mapping is known, feed a source image with a known pattern, and
 * assert the pattern lands on the texels it must. No GPU, no fixtures, no
 * eyeballing.
 */
import { assert, assertEquals } from '@std/assert';
import { Document, NodeIO } from '@gltf-transform/core';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import { reprojectTexture } from './dist/reproject.js';

/**
 * A unit quad in the XY plane: x in [-0.5, 0.5], y in [0, 1], z = 0.
 * UV (0,0) sits at the TOP-LEFT corner (world x=-0.5, y=1), matching glTF's
 * v-down convention, so texture space and image space agree by construction.
 */
async function quadGlb(path: string, normalZ: number, baseGrey = 128): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor('P')
    .setType('VEC3')
    .setArray(
      new Float32Array([
        -0.5,
        1,
        0, // 0 top-left
        0.5,
        1,
        0, // 1 top-right
        -0.5,
        0,
        0, // 2 bottom-left
        0.5,
        0,
        0, // 3 bottom-right
      ]),
    )
    .setBuffer(buffer);
  const normal = doc.createAccessor('N')
    .setType('VEC3')
    .setArray(
      new Float32Array([
        0,
        0,
        normalZ,
        0,
        0,
        normalZ,
        0,
        0,
        normalZ,
        0,
        0,
        normalZ,
      ]),
    )
    .setBuffer(buffer);
  const uv = doc.createAccessor('UV')
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]))
    .setBuffer(buffer);
  const indices = doc.createAccessor('I')
    .setType('SCALAR')
    .setArray(new Uint32Array([0, 2, 1, 1, 2, 3]))
    .setBuffer(buffer);

  const size = 32;
  const base = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    base[i * 4] = baseGrey;
    base[i * 4 + 1] = baseGrey;
    base[i * 4 + 2] = baseGrey;
    base[i * 4 + 3] = 255;
  }
  const tex = doc.createTexture('base')
    .setImage(encodePng({ width: size, height: size, data: base }))
    .setMimeType('image/png');
  const material = doc.createMaterial('m').setBaseColorTexture(tex);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('NORMAL', normal)
    .setAttribute('TEXCOORD_0', uv)
    .setIndices(indices)
    .setMaterial(material);
  const mesh = doc.createMesh('quad').addPrimitive(prim);
  const node = doc.createNode('quad').setMesh(mesh);
  doc.createScene('s').addChild(node);
  await fs.writeFile(path, await new NodeIO().writeBinary(doc));
}

/** Left half red, right half blue, fully opaque. */
function halvesImage(w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = (y * w + x) * 4;
      const left = x < w / 2;
      data[at] = left ? 255 : 0;
      data[at + 1] = 0;
      data[at + 2] = left ? 0 : 255;
      data[at + 3] = 255;
    }
  }
  return data;
}

async function readTexture(path: string) {
  const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(path)));
  const img = doc.getRoot().listTextures()[0].getImage()!;
  return decodePng(img);
}

test('reproject: a front-facing quad takes the source pattern, side for side', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const model = `${dir}/quad.glb`;
    const out = `${dir}/painted.glb`;
    const image = `${dir}/src.png`;
    await quadGlb(model, 1);
    await fs.writeFile(
      image,
      encodePng({ width: 64, height: 64, data: halvesImage(64, 64) }),
    );

    const stats = await reprojectTexture({ modelPath: model, imagePath: image, outPath: out });
    assert(stats.coverage > 0.9, `most of the quad is visible (coverage ${stats.coverage})`);

    const tex = await readTexture(out);
    const px = tex.data as Uint8Array;
    const at = (x: number, y: number) => (y * tex.width + x) * 4;
    const q = Math.floor(tex.width / 4);
    const mid = Math.floor(tex.height / 2);
    // world -x is image LEFT is texture u=0: red must land on the left half
    assertEquals(
      [px[at(q, mid)], px[at(q, mid) + 2]],
      [255, 0],
      'left half of the texture is the source red',
    );
    assertEquals(
      [px[at(3 * q, mid)], px[at(3 * q, mid) + 2]],
      [0, 255],
      'right half of the texture is the source blue',
    );
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('reproject: back-facing geometry keeps its generated color', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const model = `${dir}/quad.glb`;
    const out = `${dir}/painted.glb`;
    const image = `${dir}/src.png`;
    await quadGlb(model, -1, 77); // facing away from the camera
    await fs.writeFile(
      image,
      encodePng({ width: 64, height: 64, data: halvesImage(64, 64) }),
    );

    const stats = await reprojectTexture({
      modelPath: model,
      imagePath: image,
      outPath: out,
      dilatePx: 0,
    });
    assertEquals(stats.paintedTexels, 0, 'nothing painted onto back-facing geometry');

    const tex = await readTexture(out);
    const px = tex.data as Uint8Array;
    assertEquals(
      [px[0], px[1], px[2]],
      [77, 77, 77],
      'the generated base color survives untouched',
    );
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('reproject: transparent source pixels never paint', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const model = `${dir}/quad.glb`;
    const out = `${dir}/painted.glb`;
    const image = `${dir}/src.png`;
    await quadGlb(model, 1, 99);
    // fully transparent cut-out: the subject is empty, so there is nothing to
    // paint and every texel must keep the generated color
    const data = new Uint8Array(64 * 64 * 4);
    await fs.writeFile(image, encodePng({ width: 64, height: 64, data }));

    const stats = await reprojectTexture({
      modelPath: model,
      imagePath: image,
      outPath: out,
      dilatePx: 0,
    });
    assertEquals(stats.paintedTexels, 0);
    const tex = await readTexture(out);
    assertEquals((tex.data as Uint8Array)[0], 99);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('reproject: geometry is untouched - only the texture changes', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const model = `${dir}/quad.glb`;
    const out = `${dir}/painted.glb`;
    const image = `${dir}/src.png`;
    await quadGlb(model, 1);
    await fs.writeFile(
      image,
      encodePng({ width: 64, height: 64, data: halvesImage(64, 64) }),
    );
    await reprojectTexture({ modelPath: model, imagePath: image, outPath: out });

    const io = new NodeIO();
    const before = await io.readBinary(new Uint8Array(await fs.readFile(model)));
    const after = await io.readBinary(new Uint8Array(await fs.readFile(out)));
    const posOf = (d: Document) =>
      d.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION')!.getArray()!;
    assertEquals(
      Array.from(posOf(after)),
      Array.from(posOf(before)),
      'vertex positions are bit-identical after reprojection',
    );
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('reproject: a non-RGBA source is refused actionably', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const model = `${dir}/quad.glb`;
    const image = `${dir}/gray.png`;
    await quadGlb(model, 1);
    await fs.writeFile(
      image,
      encodePng({ width: 8, height: 8, data: new Uint8Array(64), channels: 1, depth: 8 }),
    );
    let threw = false;
    try {
      await reprojectTexture({ modelPath: model, imagePath: image, outPath: `${dir}/o.glb` });
    } catch (err) {
      threw = true;
      assert(String(err).includes('RGBA'), `names the problem: ${err}`);
      assert(String(err).includes('prep'), `names the fix: ${err}`);
    }
    assert(threw, 'a non-cut-out source must be refused, not silently painted');
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
