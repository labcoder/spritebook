import { test } from 'node:test';
/**
 * Node placement — no GPU. In glTF a NODE is the only thing that says where a
 * mesh is, and the loader used to ignore that entirely: it read `listMeshes()`
 * and bound anything unskinned to joint 0. Three rules are pinned here.
 *
 *   1. an IDENTITY mesh node changes nothing at all — the fast path that keeps
 *      every committed fixture byte-identical, and the reason a change this
 *      deep in the loader could be made without a golden refresh;
 *   2. a RIGID mesh bakes its node's rest world transform and rigid-binds to
 *      the nearest joint at or above it, so a socketed prop bakes in the hand
 *      and rides it through a clip;
 *   3. a SKINNED node's own transform is ignored, because the spec says its
 *      joints place it.
 *
 * The animation half of (2) is proved on the CPU at the bottom: skinning is
 * deterministic arithmetic, so "the sword stays in the hand" does not need a
 * GPU to be true — attachment_test.ts then proves it in real pixels.
 */
import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { Document } from '@gltf-transform/core';
import { documentToAsset, evalPosesMatrices } from './dist/skinning.js';

type Acc = (type: 'VEC3' | 'VEC4' | 'MAT4' | 'SCALAR', array: ArrayLike<number>) => never;

/** A 2-joint rig: `root` at the origin, `hand` translated (2,3,0) under it. */
function riggedDoc() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc =
    ((type: string, array: ArrayLike<number>) =>
      doc.createAccessor().setType(type as 'VEC3').setArray(array as never)
        .setBuffer(buffer)) as unknown as Acc;

  const root = doc.createNode('root');
  const hand = doc.createNode('hand').setTranslation([2, 3, 0]);
  root.addChild(hand);

  // IBM = inverse(rest world) — the precondition the rigid bind relies on
  const ibm = new Float32Array(32);
  for (let j = 0; j < 2; j++) for (let e = 0; e < 4; e++) ibm[j * 16 + e * 5] = 1;
  ibm[16 + 12] = -2;
  ibm[16 + 13] = -3;

  const skin = doc.createSkin('rig').setSkeleton(root).setInverseBindMatrices(acc('MAT4', ibm));
  skin.addJoint(root).addJoint(hand);

  const body = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint8Array(12)))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2])));
  const bodyNode = doc.createNode('body')
    .setMesh(doc.createMesh('body').addPrimitive(body))
    .setSkin(skin);

  doc.createScene('s').addChild(root).addChild(bodyNode);
  return { doc, acc, root, hand, bodyNode };
}

/** An unskinned triangle whose first vertex sits at its own node origin. */
function propMesh(doc: Document, acc: Acc, name = 'prop') {
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2])));
  return doc.createMesh(name).addPrimitive(prim);
}

/** A standalone unskinned doc with one mesh node, for transform tests. */
function rigidDoc(configure: (node: ReturnType<Document['createNode']>) => void, name = 'n') {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc =
    ((type: string, array: ArrayLike<number>) =>
      doc.createAccessor().setType(type as 'VEC3').setArray(array as never)
        .setBuffer(buffer)) as unknown as Acc;
  const node = doc.createNode(name).setMesh(propMesh(doc, acc, 'm'));
  configure(node);
  doc.createScene('s').addChild(node);
  return doc;
}

test('placement: an identity mesh node leaves the streams byte-identical', () => {
  const doc = rigidDoc(() => {});
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const srcPos = [...(prim.getAttribute('POSITION')!.getArray() as Float32Array)];
  const srcNrm = [...(prim.getAttribute('NORMAL')!.getArray() as Float32Array)];

  const asset = documentToAsset(doc, 'test');
  assertEquals([...asset.positions], srcPos, 'positions untouched');
  assertEquals([...asset.normals], srcNrm, 'normals untouched');
});

test('placement: a rigid mesh node bakes its world transform', () => {
  const doc = rigidDoc((n) => n.setTranslation([5, 0, 0]).setScale([2, 2, 2]));
  const asset = documentToAsset(doc, 'test');
  assertEquals([...asset.positions.slice(0, 3)], [5, 0, 0], 'origin vertex placed at the node');
  assertEquals([...asset.positions.slice(3, 6)], [7, 0, 0], 'scale applies before translation');
  assertEquals(asset.bounds.max[0], 7, 'bounds follow the placement');
});

test('placement: a skinned node ignores its own transform (glTF spec)', () => {
  const { doc, bodyNode } = riggedDoc();
  const before = [...documentToAsset(doc, 'test').positions];
  bodyNode.setTranslation([100, 100, 100]);
  assertEquals(
    [...documentToAsset(doc, 'test').positions],
    before,
    "a skin's joints place it, not its own node",
  );
});

test('placement: a prop under a joint rides that joint, placed at it', () => {
  const { doc, acc, hand } = riggedDoc();
  hand.addChild(doc.createNode('attach').setMesh(propMesh(doc, acc)));

  const asset = documentToAsset(doc, 'test');
  const handIdx = asset.jointNames.indexOf('hand');
  const n = asset.positions.length / 3;
  for (let v = n - 3; v < n; v++) {
    assertEquals(asset.joints[v * 4], handIdx, 'rigid-bound to the hand');
    assertEquals(asset.weights[v * 4], 1, 'with full weight');
  }
  assertEquals(
    [...asset.positions.slice((n - 3) * 3, (n - 3) * 3 + 3)],
    [2, 3, 0],
    'the prop sits at the hand, not at the model origin',
  );
});

test('placement: a prop under NO joint rides joint 0', () => {
  const { doc, acc } = riggedDoc();
  doc.getRoot().listScenes()[0].addChild(doc.createNode('loose').setMesh(propMesh(doc, acc)));
  const asset = documentToAsset(doc, 'test');
  const n = asset.positions.length / 3;
  assertEquals(asset.joints[(n - 1) * 4], 0, 'nothing above it -> joint 0');
});

test('placement: nested wrapper nodes compose', () => {
  const { doc, acc, hand } = riggedDoc();
  hand.addChild(
    doc.createNode('wrapper').setTranslation([0, 1, 0]).addChild(
      doc.createNode('inner').setTranslation([0, 0, 4]).setMesh(propMesh(doc, acc)),
    ),
  );
  const asset = documentToAsset(doc, 'test');
  const n = asset.positions.length / 3;
  assertEquals(
    [...asset.positions.slice((n - 3) * 3, (n - 3) * 3 + 3)],
    [2, 4, 4],
    'hand(2,3,0) + wrapper(0,1,0) + inner(0,0,4)',
  );
});

test('placement: normals ride the rotation and stay unit length', () => {
  const h = Math.SQRT1_2; // 90deg about +X takes +Z to -Y (quaternion xyzw)
  const doc = rigidDoc((n) => n.setRotation([h, 0, 0, h]).setScale([3, 3, 3]));
  const asset = documentToAsset(doc, 'test');
  const [nx, ny, nz] = asset.normals.slice(0, 3);
  assertAlmostEquals(Math.hypot(nx, ny, nz), 1, 1e-6, 'scale must not leak into the normal');
  assertAlmostEquals(nx, 0, 1e-6);
  assertAlmostEquals(ny, -1, 1e-6, '+Z rotates to -Y');
  assertAlmostEquals(nz, 0, 1e-6);
});

test('placement: a mirror is allowed, a non-uniform scale is refused', () => {
  // (1/s)Q points the same way once renormalized, so a mirror is safe here
  const mirrored = documentToAsset(rigidDoc((n) => n.setScale([-1, 1, 1])), 'test');
  assertEquals(mirrored.positions[3], -1, 'mirrored across X');

  const err = assertThrows(
    () => documentToAsset(rigidDoc((n) => n.setScale([1, 2, 1]), 'lopsided'), 'test'),
    Error,
  );
  assert(
    /"lopsided"/.test(err.message) && /non-uniform scale/.test(err.message),
    `names the node and the reason: ${err.message}`,
  );
});

test('placement: skin attributes on a node that binds no skin are refused', () => {
  const { doc, acc } = riggedDoc();
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint8Array(12)))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array(12)))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2])));
  doc.getRoot().listScenes()[0].addChild(
    doc.createNode('unbound').setMesh(doc.createMesh('stray').addPrimitive(prim)),
  );

  const err = assertThrows(() => documentToAsset(doc, 'test'), Error);
  assert(
    /"stray"/.test(err.message) && /binds no skin/.test(err.message),
    `names the mesh and the problem: ${err.message}`,
  );
});

test('ACCEPTANCE (cpu): the prop STAYS in the hand while the clip moves it', () => {
  const { doc, acc, hand } = riggedDoc();
  hand.addChild(doc.createNode('attach').setMesh(propMesh(doc, acc)));
  const asset = documentToAsset(doc, 'test');
  const handIdx = asset.jointNames.indexOf('hand');
  const n = asset.positions.length / 3;

  // a 2-frame "clip": frame 0 is the bind pose, frame 1 slides the hand +X
  const FRAMES = 2;
  const jointsPerFrame = asset.jointCount;
  const poses = new Float32Array(FRAMES * jointsPerFrame * 16);
  for (let f = 0; f < FRAMES; f++) {
    for (let j = 0; j < jointsPerFrame; j++) {
      const at = (f * jointsPerFrame + j) * 16;
      poses.set(asset.bindLocals.subarray(j * 16, j * 16 + 16), at);
      if (f === 1 && j === handIdx) poses[at + 12] += 7; // the hand moves
    }
  }
  const map = Int32Array.from({ length: asset.jointCount }, (_, i) => i);

  const mats = new Float32Array(asset.jointCount * 16);
  const worlds = new Float32Array(asset.jointCount * 16);
  const propAt = (frame: number) => {
    evalPosesMatrices(asset, poses, map, jointsPerFrame, frame, mats, worlds);
    // CPU mirror of the vertex shader for the prop's first vertex
    const v = (n - 3) * 3;
    const px = asset.positions[v], py = asset.positions[v + 1], pz = asset.positions[v + 2];
    const j = asset.joints[(n - 3) * 4] * 16;
    return {
      x: mats[j] * px + mats[j + 4] * py + mats[j + 8] * pz + mats[j + 12],
      y: mats[j + 1] * px + mats[j + 5] * py + mats[j + 9] * pz + mats[j + 13],
      hand: [worlds[handIdx * 16 + 12], worlds[handIdx * 16 + 13]] as const,
    };
  };

  const rest = propAt(0);
  assertAlmostEquals(rest.x, rest.hand[0], 1e-5, 'at rest the prop is exactly at the hand');
  assertAlmostEquals(rest.y, rest.hand[1], 1e-5);

  const moved = propAt(1);
  assertAlmostEquals(moved.x, moved.hand[0], 1e-5, 'and it is STILL at the hand once it moves');
  assertAlmostEquals(moved.y, moved.hand[1], 1e-5);
  // anti-vacuity: the hand really did move, so the assertion above means something
  assert(
    Math.abs(moved.hand[0] - rest.hand[0]) > 6,
    `the hand must actually move: ${rest.hand[0]} -> ${moved.hand[0]}`,
  );
});
