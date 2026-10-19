import { test } from 'node:test';
/**
 * documentToAsset concatenation (M1) — no GPU. A canonical character is almost
 * always multi-primitive (body/clothes/hair, or extra mesh nodes); the loader
 * must fold EVERY mesh and primitive into one stream, not silently draw only the
 * first. Built in-memory so no binary fixture is needed.
 *
 * Since the loader learned the scene graph it must also REFUSE the documents it
 * cannot place: geometry only reaches the screen through a node, and one flat
 * vertex stream can hold exactly one placement of a mesh.
 */
import { assert, assertEquals, assertThrows } from '@std/assert';
import { Document } from '@gltf-transform/core';
import { documentToAsset } from './dist/skinning.js';

function tri(doc: Document, buffer: ReturnType<Document['createBuffer']>, yOffset: number) {
  const pos = doc.createAccessor().setType('VEC3').setArray(
    new Float32Array([0, yOffset, 0, 1, yOffset, 0, 0, yOffset + 1, 0]),
  ).setBuffer(buffer);
  const nrm = doc.createAccessor().setType('VEC3').setArray(
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  ).setBuffer(buffer);
  const idx = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 1, 2]))
    .setBuffer(buffer);
  return doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm)
    .setIndices(idx);
}

test('documentToAsset folds in every primitive, offsetting indices', () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh('m').addPrimitive(tri(doc, buffer, 0)).addPrimitive(
    tri(doc, buffer, 1),
  );
  doc.createScene('s').addChild(doc.createNode('n').setMesh(mesh));

  const asset = documentToAsset(doc, 'test');
  assertEquals(asset.positions.length / 3, 6, 'both primitives concatenated (3+3 verts)');
  assertEquals([...asset.indices], [0, 1, 2, 3, 4, 5], 'second primitive indices offset by 3');
  assertEquals(asset.jointCount, 1, 'static mesh -> one identity joint');
  assert([...asset.joints].every((j) => j === 0), 'every vertex rigid-bound to joint 0');
  assertEquals(asset.weights.length, 6 * 4);
  // bounds span BOTH primitives (the dropped-primitive bug would give max.y = 1)
  assertEquals(asset.bounds.max[1], 2, 'bounds include the second primitive');
  assertEquals(asset.bounds.min[1], 0);
});

test('documentToAsset spans multiple mesh nodes too', () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const meshA = doc.createMesh('a').addPrimitive(tri(doc, buffer, 0));
  const meshB = doc.createMesh('b').addPrimitive(tri(doc, buffer, 5));
  const scene = doc.createScene('s');
  scene.addChild(doc.createNode('na').setMesh(meshA));
  scene.addChild(doc.createNode('nb').setMesh(meshB));

  const asset = documentToAsset(doc, 'test');
  assertEquals(asset.positions.length / 3, 6, 'both meshes concatenated');
  assertEquals(asset.bounds.max[1], 6, 'second mesh (y offset 5) included');
});

test('documentToAsset refuses a mesh no node draws', () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  doc.createMesh('orphan').addPrimitive(tri(doc, buffer, 0));
  doc.createScene('s'); // the mesh exists, but nothing places it

  const err = assertThrows(() => documentToAsset(doc, 'test'), Error);
  assert(
    /"orphan"/.test(err.message) && /through a node/.test(err.message),
    `the refusal names the mesh and why: ${err.message}`,
  );
});

test('documentToAsset refuses an instanced mesh, naming both nodes', () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh('earring').addPrimitive(tri(doc, buffer, 0));
  const scene = doc.createScene('s');
  // one mesh, two placements - legal glTF, but a flat vertex stream cannot
  // express it, and drawing it once at one of the two spots is the silent
  // wrong answer this refuses
  scene.addChild(doc.createNode('ear-l').setMesh(mesh).setTranslation([-1, 0, 0]));
  scene.addChild(doc.createNode('ear-r').setMesh(mesh).setTranslation([1, 0, 0]));

  const err = assertThrows(() => documentToAsset(doc, 'test'), Error);
  assert(
    /"earring"/.test(err.message) && /"ear-l"/.test(err.message) && /"ear-r"/.test(err.message),
    `the refusal names the mesh and every node drawing it: ${err.message}`,
  );
  assert(/Duplicate the mesh/.test(err.message), `and names the fix: ${err.message}`);
});
