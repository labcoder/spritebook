import { rejects } from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The identity layer is UV-space and graph-space surgery, so it is testable
 * EXACTLY: a body whose three quads sit in three known UV rects and are weighted
 * to three known joints, and a decal whose pattern is asymmetric on purpose.
 * No GPU, no goldens, no eyeballing.
 *
 * The load-bearing test here is the NEGATIVE one: `mirrored: false` paints one
 * region and leaves the partner byte-identical. That is D-008 — asymmetric
 * identity is first-class — and it is the assertion that fails the day someone
 * decides mirroring is a helpful default.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { Document, NodeIO } from '@gltf-transform/core';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import type { CanonicalBody } from '@spritebook/schema';
import {
  applyAttachments,
  applyBoneMask,
  compositeDecals,
  REGION_WEIGHT_FLOOR,
  sidePartnerRegion,
} from './dist/identity.js';

const TEX = 64;

/** The three regions of the test body, matching `bodyGlb`'s quads exactly. */
const BODY: CanonicalBody = {
  schemaVersion: 2,
  id: 'test-body',
  displayName: 'Test body',
  license: 'CC0-1.0',
  source: 'fixture',
  skeleton: 'ual-humanoid',
  jointCount: 3,
  vertexCount: 12,
  heightM: 1.8,
  regions: [
    {
      id: 'forearm-l',
      joints: ['forearm-l'],
      uvRect: { x: 0, y: 0, w: 0.25, h: 0.25 },
      side: 'left',
    },
    {
      id: 'forearm-r',
      joints: ['forearm-r'],
      uvRect: { x: 0.5, y: 0, w: 0.25, h: 0.25 },
      side: 'right',
    },
    {
      id: 'chest',
      joints: ['root'],
      uvRect: { x: 0.25, y: 0.5, w: 0.5, h: 0.5 },
      side: 'center',
    },
  ],
};

const rectOf = (id: string) => BODY.regions.find((r) => r.id === id)!.uvRect;

/** Texel rect of a region on a `size`-square texture (mirrors identity.ts). */
function texels(id: string, size = TEX) {
  const r = rectOf(id);
  return {
    x: Math.round(r.x * size),
    y: Math.round(r.y * size),
    w: Math.round(r.w * size),
    h: Math.round(r.h * size),
  };
}

/**
 * A skinned body of three quads — one per region, each 100% weighted to that
 * region's joint, each UV-mapped onto its region's rect. Grey 128 texture.
 */
async function bodyGlb(path: string): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const quads = [
    { joint: 0, region: 'chest', x: 0 },
    { joint: 1, region: 'forearm-l', x: 2 },
    { joint: 2, region: 'forearm-r', x: -2 },
  ];
  quads.forEach((q, i) => {
    const r = rectOf(q.region);
    // corners: TL, TR, BL, BR in both world and UV, so the mapping is obvious
    const corners: Array<[number, number]> = [[0, 1], [1, 1], [0, 0], [1, 0]];
    for (const [cx, cy] of corners) {
      positions.push(q.x + cx, cy, 0);
      normals.push(0, 0, 1);
      uvs.push(r.x + cx * r.w, r.y + (1 - cy) * r.h);
      joints.push(q.joint, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
    const base = i * 4;
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  });

  const acc = (
    name: string,
    type: 'VEC3' | 'VEC2' | 'VEC4' | 'MAT4' | 'SCALAR',
    array: ArrayLike<number>,
  ) => doc.createAccessor(name).setType(type).setArray(array as never).setBuffer(buffer);

  const base = new Uint8Array(TEX * TEX * 4).fill(128);
  for (let i = 3; i < base.length; i += 4) base[i] = 255;
  const material = doc.createMaterial('body').setBaseColorTexture(
    doc.createTexture('base')
      .setImage(encodePng({ width: TEX, height: TEX, data: base }))
      .setMimeType('image/png'),
  );

  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('P', 'VEC3', new Float32Array(positions)))
    .setAttribute('NORMAL', acc('N', 'VEC3', new Float32Array(normals)))
    .setAttribute('TEXCOORD_0', acc('UV', 'VEC2', new Float32Array(uvs)))
    .setAttribute('JOINTS_0', acc('J', 'VEC4', new Uint8Array(joints)))
    .setAttribute('WEIGHTS_0', acc('W', 'VEC4', new Float32Array(weights)))
    .setIndices(acc('I', 'SCALAR', new Uint16Array(indices)))
    .setMaterial(material);
  const node = doc.createNode('body').setMesh(doc.createMesh('body').addPrimitive(prim));

  const jointNodes = ['root', 'forearm-l', 'forearm-r'].map((n) => doc.createNode(n));
  const ibm = new Float32Array(jointNodes.length * 16);
  for (let j = 0; j < jointNodes.length; j++) {
    for (let e = 0; e < 4; e++) ibm[j * 16 + e * 5] = 1; // identity
  }
  const skin = doc.createSkin('rig')
    .setSkeleton(jointNodes[0])
    .setInverseBindMatrices(acc('IBM', 'MAT4', ibm));
  for (const j of jointNodes) skin.addJoint(j);
  jointNodes[0].addChild(jointNodes[1]).addChild(jointNodes[2]);
  node.setSkin(skin);
  doc.createScene('s').addChild(node).addChild(jointNodes[0]);

  await fs.writeFile(path, await new NodeIO().writeBinary(doc));
}

/** A rigid quad prop, optionally under a translated node (world-transform test). */
async function propGlb(path: string, lift = 0): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC3' | 'SCALAR', array: ArrayLike<number>) =>
    doc.createAccessor().setType(type).setArray(array as never).setBuffer(buffer);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 1, 3, 2])));
  const node = doc.createNode('prop')
    .setMesh(doc.createMesh('prop').addPrimitive(prim))
    .setTranslation([0, lift, 0]);
  doc.createScene('s').addChild(node);
  await fs.writeFile(path, await new NodeIO().writeBinary(doc));
}

/**
 * A replacement that IS skinned, to a one-joint skeleton named after a body
 * joint. Its own joint index is 0; the body's `forearm-l` is index 1, so a
 * remap that went by index instead of by NAME would bind it to the root.
 */
async function skinnedReplacementGlb(path: string, jointName: string): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC3' | 'VEC4' | 'MAT4' | 'SCALAR', array: ArrayLike<number>) =>
    doc.createAccessor().setType(type).setArray(array as never).setBuffer(buffer);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint8Array(16)))
    .setAttribute(
      'WEIGHTS_0',
      acc('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])),
    )
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 1, 3, 2])));
  const joint = doc.createNode(jointName);
  const ibm = new Float32Array(16);
  for (let e = 0; e < 4; e++) ibm[e * 5] = 1;
  const skin = doc.createSkin('rig')
    .setSkeleton(joint)
    .setInverseBindMatrices(acc('MAT4', ibm))
    .addJoint(joint);
  const node = doc.createNode('replacement')
    .setMesh(doc.createMesh('replacement').addPrimitive(prim))
    .setSkin(skin);
  doc.createScene('s').addChild(node).addChild(joint);
  await fs.writeFile(path, await new NodeIO().writeBinary(doc));
}

/** Left column red, everything else blue — a pattern a flip cannot hide. */
function sidedDecal(size = 8): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4;
      const left = x < size / 2;
      data[at] = left ? 255 : 0;
      data[at + 2] = left ? 0 : 255;
      data[at + 3] = 255;
    }
  }
  return data;
}

function solid(size: number, rgba: [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set(rgba, i * 4);
  return data;
}

async function readTexture(path: string) {
  const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(path)));
  return decodePng(doc.getRoot().listTextures()[0].getImage()!);
}

async function readPositions(path: string): Promise<number[]> {
  const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(path)));
  const out: number[] = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      out.push(...Array.from(prim.getAttribute('POSITION')?.getArray() ?? []));
    }
  }
  return out;
}

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Decals
// ---------------------------------------------------------------------------

test('decal: lands inside its region rect and nowhere else', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const out = `${dir}/out.glb`;
    const png = `${dir}/decal.png`;
    await bodyGlb(model);
    await fs.writeFile(png, encodePng({ width: 8, height: 8, data: solid(8, [255, 0, 0, 255]) }));

    const report = await compositeDecals({
      modelPath: model,
      body: BODY,
      outPath: out,
      decals: [{ id: 'tattoo', pngPath: png, region: 'forearm-l', z: 0, mirrored: false }],
    });

    const want = texels('forearm-l');
    assertEquals(report.landings.length, 1, 'one decal, one composite');
    assertEquals(report.landings[0].rect, want);
    assertEquals(report.landings[0].region, 'forearm-l');
    assertEquals(report.landings[0].changedTexels, want.w * want.h, 'every texel of the rect');
    assertEquals(report.missed, [], 'nothing silently missed');

    const tex = await readTexture(out);
    const px = tex.data as Uint8Array;
    let inside = 0, outside = 0;
    for (let y = 0; y < tex.height; y++) {
      for (let x = 0; x < tex.width; x++) {
        const at = (y * tex.width + x) * 4;
        const isIn = x >= want.x && x < want.x + want.w && y >= want.y && y < want.y + want.h;
        const red = px[at] === 255 && px[at + 1] === 0 && px[at + 2] === 0;
        if (isIn && red) inside++;
        if (!isIn && px[at] !== 128) outside++;
      }
    }
    assertEquals(inside, want.w * want.h, 'the whole rect is the decal');
    assertEquals(outside, 0, 'not one texel outside the rect was touched');
  });
});

test('decal: mirrored paints BOTH sides, and the copy really is flipped', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const out = `${dir}/out.glb`;
    const png = `${dir}/decal.png`;
    await bodyGlb(model);
    await fs.writeFile(png, encodePng({ width: 8, height: 8, data: sidedDecal(8) }));

    const report = await compositeDecals({
      modelPath: model,
      body: BODY,
      outPath: out,
      decals: [{ id: 'tattoo', pngPath: png, region: 'forearm-l', z: 0, mirrored: true }],
    });
    assertEquals(report.landings.length, 2, 'a mirrored decal is TWO composites');
    assertEquals(report.landings[1].region, 'forearm-r', 'the side partner, found by name');
    assertEquals(report.landings[1].mirrored, true);
    assertEquals(report.landings[1].rect, texels('forearm-r'));

    const tex = await readTexture(out);
    const px = tex.data as Uint8Array;
    const left = texels('forearm-l');
    const right = texels('forearm-r');
    const at = (x: number, y: number) => (y * tex.width + x) * 4;
    for (let y = 0; y < left.h; y++) {
      for (let x = 0; x < left.w; x++) {
        const src = at(left.x + x, left.y + y);
        const dst = at(right.x + (right.w - 1 - x), right.y + y);
        assertEquals(
          [px[dst], px[dst + 1], px[dst + 2]],
          [px[src], px[src + 1], px[src + 2]],
          `partner texel (${x},${y}) is the mirror of the source`,
        );
      }
    }
    // and the flip is real, not a copy: the red column swapped sides
    assertEquals(px[at(left.x, left.y)], 255, 'source: red on its left edge');
    assertEquals(px[at(right.x + right.w - 1, right.y)], 255, 'partner: red on its RIGHT edge');
    assertEquals(px[at(right.x, right.y)], 0, 'partner: blue where the source had red');
  });
});

test('decal: mirrored:false paints exactly one side (D-008, the negative proof)', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const out = `${dir}/out.glb`;
    const png = `${dir}/decal.png`;
    await bodyGlb(model);
    await fs.writeFile(png, encodePng({ width: 8, height: 8, data: sidedDecal(8) }));

    const report = await compositeDecals({
      modelPath: model,
      body: BODY,
      outPath: out,
      // the default, spelled out: this is the promise the product is built on
      decals: [{ id: 'tattoo', pngPath: png, region: 'forearm-l', z: 0, mirrored: false }],
    });
    assertEquals(report.landings.length, 1, 'one region, one composite');
    assert(!report.landings.some((l) => l.mirrored), 'nothing was mirrored');

    const tex = await readTexture(out);
    const px = tex.data as Uint8Array;
    const right = texels('forearm-r');
    for (let y = 0; y < right.h; y++) {
      for (let x = 0; x < right.w; x++) {
        const at = ((right.y + y) * tex.width + right.x + x) * 4;
        assertEquals(
          [px[at], px[at + 1], px[at + 2]],
          [128, 128, 128],
          `the other arm is untouched at (${x},${y})`,
        );
      }
    }
  });
});

test('decal: z order wins overlaps; equal z keeps input order', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    await bodyGlb(model);
    const red = `${dir}/red.png`, blue = `${dir}/blue.png`;
    await fs.writeFile(red, encodePng({ width: 4, height: 4, data: solid(4, [255, 0, 0, 255]) }));
    await fs.writeFile(
      blue,
      encodePng({ width: 4, height: 4, data: solid(4, [0, 0, 255, 255]) }),
    );
    const at = texels('chest');
    const read = async (path: string) => {
      const tex = await readTexture(path);
      const px = tex.data as Uint8Array;
      const o = (at.y * tex.width + at.x) * 4;
      return [px[o], px[o + 1], px[o + 2]];
    };

    // higher z wins regardless of input order
    await compositeDecals({
      modelPath: model,
      body: BODY,
      outPath: `${dir}/z.glb`,
      decals: [
        { id: 'top', pngPath: blue, region: 'chest', z: 5, mirrored: false },
        { id: 'bottom', pngPath: red, region: 'chest', z: 1, mirrored: false },
      ],
    });
    assertEquals(await read(`${dir}/z.glb`), [0, 0, 255], 'z 5 covers z 1');

    // equal z: the later input wins, because the sort is STABLE
    await compositeDecals({
      modelPath: model,
      body: BODY,
      outPath: `${dir}/tie.glb`,
      decals: [
        { id: 'first', pngPath: blue, region: 'chest', z: 0, mirrored: false },
        { id: 'second', pngPath: red, region: 'chest', z: 0, mirrored: false },
      ],
    });
    assertEquals(await read(`${dir}/tie.glb`), [255, 0, 0], 'equal z keeps input order');
  });
});

test('decal: a composite that changes nothing is REPORTED, not swallowed', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const png = `${dir}/empty.png`;
    await bodyGlb(model);
    await fs.writeFile(png, encodePng({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) }));
    const report = await compositeDecals({
      modelPath: model,
      body: BODY,
      outPath: `${dir}/out.glb`,
      decals: [{ id: 'ghost', pngPath: png, region: 'chest', z: 0, mirrored: false }],
    });
    assertEquals(report.landings[0].changedTexels, 0);
    assertEquals(report.missed, ['ghost'], 'a decal that painted nothing is named');
    assertEquals(report.changedTexels, 0);
  });
});

test('decal: an unknown region is refused, with the real options listed', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const png = `${dir}/decal.png`;
    await bodyGlb(model);
    await fs.writeFile(png, encodePng({ width: 4, height: 4, data: solid(4, [1, 2, 3, 255]) }));
    let threw = false;
    try {
      await compositeDecals({
        modelPath: model,
        body: BODY,
        outPath: `${dir}/out.glb`,
        decals: [{ id: 'tattoo', pngPath: png, region: 'shin-l', z: 0, mirrored: false }],
      });
    } catch (err) {
      threw = true;
      const message = String(err);
      assert(message.includes('tattoo'), `names the decal: ${message}`);
      assert(message.includes('shin-l'), `names the bad region: ${message}`);
      assert(message.includes('forearm-l'), `lists what IS available: ${message}`);
    }
    assert(threw, 'a typo must not silently paint nothing');
  });
});

test('decal: a mirrored decal on a centre region is refused', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const png = `${dir}/decal.png`;
    await bodyGlb(model);
    await fs.writeFile(png, encodePng({ width: 4, height: 4, data: solid(4, [1, 2, 3, 255]) }));
    let threw = false;
    try {
      await compositeDecals({
        modelPath: model,
        body: BODY,
        outPath: `${dir}/out.glb`,
        decals: [{ id: 'emblem', pngPath: png, region: 'chest', z: 0, mirrored: true }],
      });
    } catch (err) {
      threw = true;
      assert(String(err).includes('centre line'), `explains why: ${err}`);
    }
    assert(threw);
  });
});

test('decal: geometry is bit-identical after compositing', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const out = `${dir}/out.glb`;
    const png = `${dir}/decal.png`;
    await bodyGlb(model);
    await fs.writeFile(png, encodePng({ width: 8, height: 8, data: sidedDecal(8) }));
    await compositeDecals({
      modelPath: model,
      body: BODY,
      outPath: out,
      decals: [{ id: 'tattoo', pngPath: png, region: 'forearm-l', z: 0, mirrored: true }],
    });
    assertEquals(
      await readPositions(out),
      await readPositions(model),
      'vertex positions are bit-identical after compositing',
    );
  });
});

test('side partner: naming only, in every spelling a body id can use', () => {
  assertEquals(sidePartnerRegion('forearm-l'), 'forearm-r');
  assertEquals(sidePartnerRegion('forearm-r'), 'forearm-l');
  assertEquals(sidePartnerRegion('forearm_l'), 'forearm_r'); // the rig's joint spelling
  assertEquals(sidePartnerRegion('left-forearm'), 'right-forearm');
  assertEquals(sidePartnerRegion('chest'), null, 'a centre region has no partner');
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const SOCKETS = [
  { id: 'hand-r', bone: 'forearm-r', localOffset: [0, 0.1, 0] },
  { id: 'head-top', bone: 'root', localOffset: [0, 0, 0] },
];

test('attachment: lands under its socket joint, offset applied, body untouched', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const prop = `${dir}/prop.glb`;
    const out = `${dir}/out.glb`;
    await bodyGlb(model);
    await propGlb(prop);

    const report = await applyAttachments({
      modelPath: model,
      sockets: SOCKETS,
      outPath: out,
      attachments: [{ id: 'sword', socketId: 'hand-r', meshPath: prop, offset: [0.5, 0, 0] }],
    });
    assertEquals(report.attached.length, 1);
    assertEquals(report.attached[0].bone, 'forearm-r');
    assertEquals(report.attached[0].offset, [0.5, 0.1, 0], 'socket offset + the user nudge');
    assertEquals(report.attached[0].vertices, 4);

    const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(out)));
    const joint = doc.getRoot().listNodes().find((n) => n.getName() === 'forearm-r')!;
    const wrapper = joint.listChildren().find((c) => c.getName() === 'attach-sword');
    assert(wrapper, 'the attachment hangs off the joint, so animation carries it');
    assertEquals(wrapper!.getTranslation(), [0.5, 0.1, 0]);
    assertEquals(wrapper!.listChildren()[0].getMesh()!.listPrimitives().length, 1);
    // it is still ONE skin: the prop rides the joint, it does not join the skin
    assertEquals(doc.getRoot().listSkins().length, 1);
    assertEquals(
      await readPositions(model),
      (await readPositions(out)).slice(0, 36),
      'the body keeps its own vertices, in place',
    );
  });
});

test('attachment: an unknown socket is refused, listing the sockets that exist', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const prop = `${dir}/prop.glb`;
    await bodyGlb(model);
    await propGlb(prop);
    let threw = false;
    try {
      await applyAttachments({
        modelPath: model,
        sockets: SOCKETS,
        outPath: `${dir}/out.glb`,
        attachments: [{ id: 'sword', socketId: 'hand-left', meshPath: prop }],
      });
    } catch (err) {
      threw = true;
      const message = String(err);
      assert(message.includes('hand-left'), `names the bad socket: ${message}`);
      assert(message.includes('hand-r'), `lists the real ones: ${message}`);
      assert(message.includes('head-top'), `all of them: ${message}`);
    }
    assert(threw, 'a bad socket id must not silently drop the attachment');
  });
});

test('attachment: a skinned "prop" is refused with the reason', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const skinned = `${dir}/skinned.glb`;
    await bodyGlb(model);
    await bodyGlb(skinned); // a skinned mesh, used where a rigid prop belongs
    let threw = false;
    try {
      await applyAttachments({
        modelPath: model,
        sockets: SOCKETS,
        outPath: `${dir}/out.glb`,
        attachments: [{ id: 'arm', socketId: 'hand-r', meshPath: skinned }],
      });
    } catch (err) {
      threw = true;
      assert(String(err).includes('bone mask'), `points at the right tool: ${err}`);
    }
    assert(threw);
  });
});

// ---------------------------------------------------------------------------
// Bone masks
// ---------------------------------------------------------------------------

test('bone mask: replaces exactly its region, rigid-bound and SAID so', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const replacement = `${dir}/arm.glb`;
    const out = `${dir}/out.glb`;
    await bodyGlb(model);
    await propGlb(replacement, 5); // authored under a lifted node

    const report = await applyBoneMask({
      modelPath: model,
      body: BODY,
      outPath: out,
      mask: { 'forearm-l': replacement },
    });
    assertEquals(report.weightFloor, REGION_WEIGHT_FLOOR);
    assertEquals(report.replaced.length, 1);
    const r = report.replaced[0];
    assertEquals(r.removedTriangles, 2, 'the region quad, and only it');
    assertEquals(r.removedVertices, 4);
    assertEquals(r.insertedVertices, 4);
    assertEquals(r.binding, 'rigid', 'an unskinned replacement cannot deform');
    assertEquals(r.rigidJoint, 'forearm-l', 'so it follows the joint that owned the region');
    assert(r.note?.includes('rigidly'), `and the report says so: ${r.note}`);

    const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(out)));
    const prims = doc.getRoot().listMeshes()[0].listPrimitives();
    const positions = prims.flatMap((p) => Array.from(p.getAttribute('POSITION')!.getArray()!));
    assertEquals(positions.length / 3, 12, '12 - 4 removed + 4 inserted');
    // the OTHER regions survive untouched
    assert(positions.includes(-2), 'the right forearm quad is still there');
    assert(!positions.some((v, i) => i % 3 === 0 && v === 2), 'the masked quad is gone');
    // the replacement kept its authored world position (node transform baked in)
    assert(positions.includes(5), 'the replacement landed where it was authored');

    const added = prims[prims.length - 1];
    const joints = added.getAttribute('JOINTS_0')!.getArray()!;
    const weights = added.getAttribute('WEIGHTS_0')!.getArray()!;
    for (let v = 0; v < 4; v++) {
      assertEquals(joints[v * 4], 1, 'every replacement vertex rides forearm-l');
      assertEquals(weights[v * 4], 1, 'with full weight, so rest pose is the identity');
    }
  });
});

test('bone mask: a skinned replacement keeps its weights, remapped BY NAME', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const replacement = `${dir}/arm.glb`;
    const out = `${dir}/out.glb`;
    await bodyGlb(model);
    await skinnedReplacementGlb(replacement, 'forearm-l');

    const report = await applyBoneMask({
      modelPath: model,
      body: BODY,
      outPath: out,
      mask: { 'forearm-l': replacement },
    });
    assertEquals(report.replaced[0].binding, 'skinned', 'it can deform, so it does');
    assertEquals(report.replaced[0].rigidJoint, undefined);
    assertEquals(report.replaced[0].note, undefined, 'nothing to warn about');

    const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(out)));
    const prims = doc.getRoot().listMeshes()[0].listPrimitives();
    const joints = prims[prims.length - 1].getAttribute('JOINTS_0')!.getArray()!;
    for (let v = 0; v < 4; v++) {
      assertEquals(joints[v * 4], 1, "its joint 0 is the body's joint 1 — matched by name");
    }
  });
});

test('bone mask: a replacement naming unknown joints falls back to rigid, loudly', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const replacement = `${dir}/arm.glb`;
    await bodyGlb(model);
    await skinnedReplacementGlb(replacement, 'tentacle-3');

    const report = await applyBoneMask({
      modelPath: model,
      body: BODY,
      outPath: `${dir}/out.glb`,
      mask: { 'forearm-l': replacement },
    });
    assertEquals(report.replaced[0].binding, 'rigid');
    assertEquals(report.replaced[0].rigidJoint, 'forearm-l');
    assert(
      report.replaced[0].note?.includes('tentacle-3'),
      `the report names the joints that were missing: ${report.replaced[0].note}`,
    );
  });
});

test('bone mask: an unknown region is refused, with the regions that exist', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const replacement = `${dir}/arm.glb`;
    await bodyGlb(model);
    await propGlb(replacement);
    let threw = false;
    try {
      await applyBoneMask({
        modelPath: model,
        body: BODY,
        outPath: `${dir}/out.glb`,
        mask: { 'tail': replacement },
      });
    } catch (err) {
      threw = true;
      const message = String(err);
      assert(message.includes('tail'), `names it: ${message}`);
      assert(message.includes('forearm-r'), `lists the real regions: ${message}`);
    }
    assert(threw);
  });
});

test('bone mask: the weight floor is the ownership rule, and it is tunable', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const replacement = `${dir}/arm.glb`;
    await bodyGlb(model);
    await propGlb(replacement);
    // every fixture vertex is 100% one joint, so no floor below 1 can change the
    // cut — the guarantee that matters is that a floor of 0.5 makes ownership
    // unique, which is what keeps two masks from fighting over a seam vertex
    const low = await applyBoneMask({
      modelPath: model,
      body: BODY,
      outPath: `${dir}/low.glb`,
      mask: { 'forearm-l': replacement },
      weightFloor: 0.01,
    });
    assertEquals(low.weightFloor, 0.01);
    assertEquals(low.replaced[0].removedTriangles, 2);

    let threw = false;
    try {
      await applyBoneMask({
        modelPath: model,
        body: BODY,
        outPath: `${dir}/bad.glb`,
        mask: { 'forearm-l': replacement },
        weightFloor: 1,
      });
    } catch (err) {
      threw = true;
      assert(String(err).includes('weightFloor'), `${err}`);
    }
    assert(threw, 'a floor of 1 can never be exceeded — refused rather than a silent no-op');
  });
});

test('compositeDecals: an RGB (3-channel) base texture is normalized, not a crash', async () => {
  // fixture-gen and other generators emit RGB base textures; every stride
  // computation in the compositor assumes RGBA, so an un-normalized base died
  // inside fast-png with "wrong data size" (found by the identity job's decal
  // test - this pins the fix at the decode boundary)
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const model = `${dir}/rgb-body.glb`;
    await bodyGlb(model);
    // swap the texture for a 3-channel RGB one, same size
    const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(model)));
    const rgb = new Uint8Array(TEX * TEX * 3).fill(99);
    doc.getRoot().listTextures()[0]
      .setImage(encodePng({ width: TEX, height: TEX, data: rgb, channels: 3 }))
      .setMimeType('image/png');
    await fs.writeFile(model, await new NodeIO().writeBinary(doc));

    const decalPng = `${dir}/mark.png`;
    await fs.writeFile(
      decalPng,
      encodePng({ width: 8, height: 8, data: solid(8, [255, 0, 255, 255]) }),
    );
    const out = `${dir}/out.glb`;
    const report = await compositeDecals({
      modelPath: model,
      decals: [{ id: 'mark', pngPath: decalPng, region: 'forearm-l', z: 0, mirrored: false }],
      body: BODY,
      outPath: out,
    });
    assert(
      report.landings.length === 1 && report.changedTexels > 0,
      'the decal landed on the normalized base',
    );
    assertEquals(report.missed, [], 'nothing silently missed');

    // and the output texture is valid RGBA with the untouched area preserved
    const outDoc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(out)));
    const tex = decodePng(outDoc.getRoot().listTextures()[0].getImage()!);
    assertEquals(tex.channels, 4, 'output is RGBA');
    const px = tex.data as Uint8Array;
    // probe the LAST texel: pixel 0 sits inside forearm-l's uvRect (it starts
    // at 0,0) and is legitimately painted by the decal - the preserved-base
    // check belongs on a texel no region covers
    const last = (tex.width * tex.height - 1) * 4;
    assertEquals(
      [px[last], px[last + 1], px[last + 2], px[last + 3]],
      [99, 99, 99, 255],
      'RGB base preserved outside the decal, alpha filled to 255',
    );
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

/** A textured quad with UVs but NO skin — a picked gen mesh before any fit. */
async function skinlessTexturedGlb(path: string): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC3' | 'VEC2' | 'SCALAR', array: ArrayLike<number>) =>
    doc.createAccessor().setType(type).setArray(array as never).setBuffer(buffer);
  const base = new Uint8Array(TEX * TEX * 4).fill(128);
  for (let i = 3; i < base.length; i += 4) base[i] = 255;
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array([0, 1, 1, 1, 0, 0, 1, 0])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 1, 3, 2])))
    .setMaterial(
      doc.createMaterial('body').setBaseColorTexture(
        doc.createTexture('base')
          .setImage(encodePng({ width: TEX, height: TEX, data: base }))
          .setMimeType('image/png'),
      ),
    );
  doc.createScene('s').addChild(
    doc.createNode('body').setMesh(doc.createMesh('body').addPrimitive(prim)),
  );
  await fs.writeFile(path, await new NodeIO().writeBinary(doc));
}

// A region is the set of texels its JOINTS own. When that ownership cannot be
// derived, the rect alone is not a region - on a real vendor atlas a region's
// AABB spans nearly the whole page (ubc-male's arm-l is 0.996 wide), so
// painting it would cover the entire character, both arms, perfectly
// mirrored: exactly what D-008 forbids. Both ways to lose ownership refuse.
test('decals: a region decal on an UNSKINNED model is refused, not page-painted', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/picked.glb`;
    const png = `${dir}/decal.png`;
    await skinlessTexturedGlb(model);
    await fs.writeFile(
      png,
      encodePng({ width: 8, height: 8, data: solid(8, [255, 0, 255, 255]) }),
    );

    const err = await assertRejects(
      () =>
        compositeDecals({
          modelPath: model,
          body: BODY,
          outPath: `${dir}/out.glb`,
          decals: [{ id: 'tattoo', pngPath: png, region: 'forearm-l', z: 0, mirrored: false }],
        }),
      Error,
    );
    assert(
      /no skeleton/.test(err.message) && /rig --track-a/.test(err.message),
      `the refusal must name the fix (fit first, or place by uvRect): ${err.message}`,
    );
    await rejects(
      () => fs.stat(`${dir}/out.glb`), { code: 'ENOENT' },
      'a refused decal writes no model',
    );
  });
});

test('decals: a body whose region joints are absent from the skin is refused', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const png = `${dir}/decal.png`;
    await bodyGlb(model); // joints: root, forearm-l, forearm-r
    await fs.writeFile(
      png,
      encodePng({ width: 8, height: 8, data: solid(8, [255, 0, 255, 255]) }),
    );

    // same region ids, joints from a DIFFERENT skeleton convention
    const foreign: CanonicalBody = {
      ...BODY,
      regions: BODY.regions.map((r) => ({ ...r, joints: r.joints.map((j) => `mixamo:${j}`) })),
    };
    const err = await assertRejects(
      () =>
        compositeDecals({
          modelPath: model,
          body: foreign,
          outPath: `${dir}/out.glb`,
          decals: [{ id: 'tattoo', pngPath: png, region: 'forearm-l', z: 0, mirrored: false }],
        }),
      Error,
    );
    assert(
      /mixamo:forearm-l/.test(err.message),
      `the refusal must name the joints it looked for: ${err.message}`,
    );
  });
});

test('decals: a uvRect decal still paints on an unskinned model (explicit aim)', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/picked.glb`;
    const out = `${dir}/out.glb`;
    const png = `${dir}/decal.png`;
    await skinlessTexturedGlb(model);
    await fs.writeFile(
      png,
      encodePng({ width: 8, height: 8, data: solid(8, [255, 0, 255, 255]) }),
    );

    const report = await compositeDecals({
      modelPath: model,
      outPath: out,
      decals: [{
        id: 'mark',
        pngPath: png,
        uvRect: { x: 0.25, y: 0.25, w: 0.25, h: 0.25 },
        z: 0,
        mirrored: false,
      }],
    });
    assertEquals(report.missed, [], "explicit coordinates are the author's own aim");
    assert(report.changedTexels > 0, 'and they still paint');
  });
});

/** A textured quad whose base atlas is 16-BIT — the depth fast-png hands back
 * as a Uint16Array, which wraps mod 256 if it is written into a Uint8Array. */
async function deep16Glb(path: string): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC3' | 'VEC2' | 'VEC4' | 'MAT4' | 'SCALAR', array: ArrayLike<number>) =>
    doc.createAccessor().setType(type).setArray(array as never).setBuffer(buffer);
  // 0xFFFF in every channel: narrows to 255, but wraps to 0
  const deep = new Uint16Array(TEX * TEX * 4).fill(0xffff);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array([0, 1, 1, 1, 0, 0, 1, 0])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 1, 3, 2])))
    .setMaterial(
      doc.createMaterial('body').setBaseColorTexture(
        doc.createTexture('base')
          .setImage(encodePng({ width: TEX, height: TEX, data: deep, depth: 16, channels: 4 }))
          .setMimeType('image/png'),
      ),
    );
  doc.createScene('s').addChild(
    doc.createNode('body').setMesh(doc.createMesh('body').addPrimitive(prim)),
  );
  await fs.writeFile(path, await new NodeIO().writeBinary(doc));
}

test('decals: a 16-bit base texture narrows to its high byte, not mod 256', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/deep.glb`;
    const out = `${dir}/out.glb`;
    const png = `${dir}/decal.png`;
    await deep16Glb(model);
    await fs.writeFile(
      png,
      encodePng({ width: 8, height: 8, data: solid(8, [255, 0, 255, 255]) }),
    );

    await compositeDecals({
      modelPath: model,
      outPath: out,
      decals: [{
        id: 'mark',
        pngPath: png,
        uvRect: { x: 0, y: 0, w: 0.25, h: 0.25 },
        z: 0,
        mirrored: false,
      }],
    });

    const tex = await readTexture(out);
    const px = tex.data as Uint8Array;
    const last = (tex.width * tex.height - 1) * 4; // outside the decal rect
    assertEquals(
      [px[last], px[last + 1], px[last + 2], px[last + 3]],
      [255, 255, 255, 255],
      'white stays white - a mod-256 wrap would have turned 0xffff into black',
    );
  });
});

test('decals: an unnamed atlas on a multi-material model warns which one it took', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const out = `${dir}/out.glb`;
    const png = `${dir}/decal.png`;
    await multiMaterialGlb(model);
    await fs.writeFile(
      png,
      encodePng({ width: 8, height: 8, data: solid(8, [255, 0, 255, 255]) }),
    );

    const report = await compositeDecals({
      modelPath: model,
      outPath: out,
      decals: [{
        id: 'mark',
        pngPath: png,
        uvRect: { x: 0, y: 0, w: 0.25, h: 0.25 },
        z: 0,
        mirrored: false,
      }],
    });

    assertEquals(report.material, 'skin', 'the largest primitive wins the guess');
    assertEquals(report.warnings.length, 1, 'and the guess is announced, not silent');
    assert(
      /2 materials/.test(report.warnings[0]) && /bodyMaterial/.test(report.warnings[0]),
      `the warning must name the count and the fix: ${report.warnings[0]}`,
    );
  });
});

test('decals: a body that NAMES its atlas paints there, with no warning', async () => {
  await withTmp(async (dir) => {
    const model = `${dir}/body.glb`;
    const png = `${dir}/decal.png`;
    await multiMaterialGlb(model);
    await fs.writeFile(
      png,
      encodePng({ width: 8, height: 8, data: solid(8, [255, 0, 255, 255]) }),
    );

    const report = await compositeDecals({
      modelPath: model,
      body: { ...BODY, bodyMaterial: 'hair' },
      outPath: `${dir}/out.glb`,
      decals: [{
        id: 'mark',
        pngPath: png,
        uvRect: { x: 0, y: 0, w: 0.25, h: 0.25 },
        z: 0,
        mirrored: false,
      }],
    });
    assertEquals(report.material, 'hair', 'the manifest overrules the size heuristic');
    assertEquals(report.warnings, [], 'a named atlas is not a guess');
  });
});

/**
 * Two materials, two primitives: a big "skin" quad and a small "hair" one.
 * The size heuristic must take skin; a manifest naming hair must overrule it.
 */
async function multiMaterialGlb(path: string): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC3' | 'VEC2' | 'SCALAR', array: ArrayLike<number>) =>
    doc.createAccessor().setType(type).setArray(array as never).setBuffer(buffer);
  const atlas = (name: string, grey: number) => {
    const base = new Uint8Array(TEX * TEX * 4).fill(grey);
    for (let i = 3; i < base.length; i += 4) base[i] = 255;
    return doc.createMaterial(name).setBaseColorTexture(
      doc.createTexture(name)
        .setImage(encodePng({ width: TEX, height: TEX, data: base }))
        .setMimeType('image/png'),
    );
  };
  const quad = (verts: number, material: ReturnType<typeof atlas>) => {
    const positions = new Float32Array(verts * 3);
    const uvs = new Float32Array(verts * 2);
    for (let v = 0; v < verts; v++) {
      positions[v * 3] = v % 2;
      positions[v * 3 + 1] = Math.floor(v / 2) % 2;
      uvs[v * 2] = (v % 2) * 0.25;
      uvs[v * 2 + 1] = (Math.floor(v / 2) % 2) * 0.25;
    }
    return doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', positions))
      .setAttribute('TEXCOORD_0', acc('VEC2', uvs))
      .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 1, 3, 2])))
      .setMaterial(material);
  };
  doc.createScene('s').addChild(
    doc.createNode('body').setMesh(
      doc.createMesh('body')
        .addPrimitive(quad(8, atlas('skin', 128)))
        .addPrimitive(quad(4, atlas('hair', 64))),
    ),
  );
  await fs.writeFile(path, await new NodeIO().writeBinary(doc));
}
