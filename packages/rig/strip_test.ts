import { test } from 'node:test';
/**
 * The strip's contract, pinned: skins and skinning attributes go, geometry
 * and mesh placement stay, and the two joint-node cases part ways — a joint
 * that is an ancestor of a mesh is KEPT (removing it would move the mesh), a
 * leaf-only joint chain is removed so re-rigs do not accumulate dead nodes.
 */
import { assert, assertEquals } from '@std/assert';
import { Document } from '@gltf-transform/core';
import { stripSkins } from './dist/strip.js';

/** A minimal skinned doc: one triangle, two joints, one skin. */
function skinnedDoc(opts: { meshUnderJoint: boolean }): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();

  const position = doc.createAccessor('POSITION').setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const joints = doc.createAccessor('JOINTS_0').setType('VEC4').setBuffer(buffer)
    .setArray(new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]));
  const weights = doc.createAccessor('WEIGHTS_0').setType('VEC4').setBuffer(buffer)
    .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  const ibm = doc.createAccessor('IBM').setType('MAT4').setBuffer(buffer)
    .setArray(
      new Float32Array([
        ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      ]),
    );

  const prim = doc.createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('JOINTS_0', joints)
    .setAttribute('WEIGHTS_0', weights);
  const mesh = doc.createMesh('body').addPrimitive(prim);
  const meshNode = doc.createNode('body').setMesh(mesh);

  const root = doc.createNode('hips').setTranslation([0, 1, 0]);
  const tip = doc.createNode('spine');
  root.addChild(tip);
  if (opts.meshUnderJoint) root.addChild(meshNode);
  else scene.addChild(meshNode);
  scene.addChild(root);

  const skin = doc.createSkin('skin').addJoint(root).addJoint(tip)
    .setInverseBindMatrices(ibm);
  meshNode.setSkin(skin);
  return doc;
}

test('strip removes the skin, the attributes, and a mesh-free joint chain', () => {
  const doc = skinnedDoc({ meshUnderJoint: false });
  const r = stripSkins(doc);
  assertEquals(r.skinsRemoved, 1);
  assertEquals(r.attributesRemoved, 2, 'JOINTS_0 + WEIGHTS_0');
  assertEquals(r.jointNodesRemoved, 2, 'hips and spine carried no mesh');
  const root = doc.getRoot();
  assertEquals(root.listSkins().length, 0);
  const prim = root.listMeshes()[0]!.listPrimitives()[0]!;
  assertEquals(prim.getAttribute('JOINTS_0'), null);
  assertEquals(prim.getAttribute('WEIGHTS_0'), null);
  assert(prim.getAttribute('POSITION') !== null, 'geometry stays');
  assertEquals(
    root.listAccessors().filter((a) => a.getName() === 'IBM').length,
    0,
    'the orphaned IBM accessor is disposed',
  );
});

test('a joint that is an ANCESTOR of the mesh survives as a plain node', () => {
  const doc = skinnedDoc({ meshUnderJoint: true });
  const r = stripSkins(doc);
  assertEquals(r.skinsRemoved, 1);
  const names = doc.getRoot().listNodes().map((n) => n.getName());
  assert(names.includes('hips'), 'removing it would move the mesh under it');
  assert(!names.includes('spine'), 'the mesh-free leaf still goes');
  const hips = doc.getRoot().listNodes().find((n) => n.getName() === 'hips')!;
  assertEquals(hips.getTranslation(), [0, 1, 0], 'its transform is untouched');
});

test('a clean mesh is untouched and reports zero', () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor('POSITION').setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const mesh = doc.createMesh().addPrimitive(
    doc.createPrimitive().setAttribute('POSITION', position),
  );
  doc.createScene().addChild(doc.createNode('m').setMesh(mesh));
  const r = stripSkins(doc);
  assertEquals(r, { skinsRemoved: 0, jointNodesRemoved: 0, attributesRemoved: 0 });
});

test('a joint targeted by an animation is kept - channels must not dangle', () => {
  const doc = skinnedDoc({ meshUnderJoint: false });
  const spine = doc.getRoot().listNodes().find((n) => n.getName() === 'spine')!;
  const input = doc.createAccessor().setType('SCALAR').setBuffer(doc.getRoot().listBuffers()[0]!)
    .setArray(new Float32Array([0, 1]));
  const output = doc.createAccessor().setType('VEC3').setBuffer(doc.getRoot().listBuffers()[0]!)
    .setArray(new Float32Array([0, 0, 0, 0, 1, 0]));
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output);
  const channel = doc.createAnimationChannel().setTargetNode(spine).setTargetPath('translation')
    .setSampler(sampler);
  doc.createAnimation('sway').addSampler(sampler).addChannel(channel);

  const r = stripSkins(doc);
  const names = doc.getRoot().listNodes().map((n) => n.getName());
  assert(names.includes('spine'), 'the animated joint stays');
  assert(
    names.includes('hips'),
    'its parent stays too - a surviving child pins the chain above it',
  );
  assertEquals(r.skinsRemoved, 1);
});
