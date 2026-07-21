/**
 * applyRig is a writer, so the assertions are about the FILE it wrote, re-read
 * from disk: one skin, the joint count the skeleton declared, every JOINTS_0
 * index inside the skeleton, every row summing to 1, and — the assertion that
 * actually proves the bind matrices — the rest round-trip: skin the mesh at
 * rest with this package's own CPU blend and land back on the authored
 * positions. An inverse bind matrix that is subtly wrong survives every other
 * check here and dies on that one.
 *
 * The failure tests all assert the MESSAGE, not just the throw: an adapter that
 * emits a bad row at vertex 21847 has to be debuggable from a CI log.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1';
import { NodeIO } from '@gltf-transform/core';
import {
  chainSkeleton,
  cleanWeights,
  encodeNpz,
  PIN_VERTEX,
  stageCase,
  tubePositions,
  VERTEX_COUNT,
  weightsNpz,
} from './_fixtures.ts';
import { applyRig, packWeightRows } from './apply.ts';
import { boneDirection } from './deform.ts';
import { loadRiggedAsset, mat4Multiply, restWorlds, skinAll, skinMatrices } from './skin.ts';

const UNSIGNED_BYTE = 5121;

async function messageOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected applyRig to throw');
}

function assertMentions(message: string, ...needles: string[]): void {
  for (const n of needles) {
    assert(message.includes(n), `expected "${n}" in: ${message}`);
  }
}

Deno.test('applyRig writes a skin the border would accept', async () => {
  const c = await stageCase();
  try {
    const result = await applyRig(c);
    assertEquals(result.jointCount, 5);
    assertEquals(result.vertexCount, VERTEX_COUNT);
    assertEquals(result.renormalizedVertices, 0);
    assertEquals(result.zeroWeightVertices, 0);
    assertEquals(result.truncatedVertices, 0);
    assertEquals(result.skeletonProfile, 'generic');

    const doc = await new NodeIO().readBinary(await Deno.readFile(c.outPath));
    const skins = doc.getRoot().listSkins();
    assertEquals(skins.length, 1);
    assertEquals(skins[0].listJoints().length, 5);
    assertEquals(
      skins[0].listJoints().map((j) => j.getName()),
      ['bone_0', 'bone_1', 'bone_2', 'bone_3', 'bone_4'],
    );
    // the skin has to be reachable from a node, or the importer border rejects
    // the mesh's attributes as unbound
    assert(doc.getRoot().listNodes().some((n) => n.getMesh() && n.getSkin() === skins[0]));

    const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    const jAcc = prim.getAttribute('JOINTS_0')!;
    // 5 joints fit in a byte: the documented smallest-that-fits encoding
    assertEquals(jAcc.getComponentType(), UNSIGNED_BYTE);
    assertEquals(jAcc.getNormalized(), false);
    const joints = jAcc.getArray()!;
    for (let i = 0; i < joints.length; i++) assert(joints[i] < 5, `joint index ${joints[i]}`);

    const weights = prim.getAttribute('WEIGHTS_0')!.getArray()!;
    assertEquals(weights.length, VERTEX_COUNT * 4);
    for (let v = 0; v < VERTEX_COUNT; v++) {
      const sum = weights[v * 4] + weights[v * 4 + 1] + weights[v * 4 + 2] + weights[v * 4 + 3];
      assertAlmostEquals(sum, 1, 1e-6, `vertex ${v} weights sum`);
    }
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig inverse bind matrices invert the rest world matrices', async () => {
  const c = await stageCase();
  try {
    await applyRig(c);
    const asset = await loadRiggedAsset(c.outPath);
    const worlds = restWorlds(asset);
    const out = new Float32Array(16);
    for (let j = 0; j < asset.jointCount; j++) {
      mat4Multiply(
        worlds.subarray(j * 16, j * 16 + 16),
        asset.inverseBind.subarray(j * 16, j * 16 + 16),
        out,
      );
      for (let e = 0; e < 16; e++) {
        assertAlmostEquals(out[e], e % 5 === 0 ? 1 : 0, 1e-5, `joint ${j} element ${e}`);
      }
    }
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig round-trips the rest pose through CPU skinning', async () => {
  const c = await stageCase();
  try {
    await applyRig(c);
    const asset = await loadRiggedAsset(c.outPath);
    const mats = skinMatrices(restWorlds(asset), asset.inverseBind, asset.jointCount);
    const skinned = skinAll(asset, mats);
    const original = tubePositions();
    assertEquals(skinned.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assertAlmostEquals(skinned[i], original[i], 1e-5, `component ${i}`);
    }
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig names the offending vertex for an out-of-range joint index', async () => {
  const w = cleanWeights();
  w.joints[7 * 4] = 9;
  const c = await stageCase(chainSkeleton(), await weightsNpz(w));
  try {
    assertMentions(
      await messageOf(() => applyRig(c)),
      'vertex 7',
      'joint index 9',
      'has 5 joints',
    );
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig names the offending vertex for a non-finite weight', async () => {
  const w = cleanWeights();
  w.weights[11 * 4 + 1] = NaN;
  const c = await stageCase(chainSkeleton(), await weightsNpz(w));
  try {
    assertMentions(await messageOf(() => applyRig(c)), 'vertex 11', 'influence 1', 'non-finite');
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig binds a zero-weight row to the root and reports it', async () => {
  const w = cleanWeights();
  w.weights[3 * 4] = 0; // vertex 3 now has no influence at all
  const c = await stageCase(chainSkeleton(), await weightsNpz(w));
  try {
    const result = await applyRig(c);
    assertEquals(result.zeroWeightVertices, 1);
    assertEquals(result.renormalizedVertices, 0);
    const asset = await loadRiggedAsset(c.outPath);
    // rigid-bound to joint 0: never a divide by zero, never a vertex collapsed
    // onto the origin (schema/rig.ts's zeroWeightVertices warning)
    assertEquals(asset.joints[3 * 4], 0);
    assertAlmostEquals(asset.weights[3 * 4], 1, 1e-6);
    const mats = skinMatrices(restWorlds(asset), asset.inverseBind, asset.jointCount);
    const skinned = skinAll(asset, mats);
    const original = tubePositions();
    for (let a = 0; a < 3; a++) {
      assertAlmostEquals(skinned[3 * 3 + a], original[3 * 3 + a], 1e-5);
    }
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig renormalizes sloppy rows and counts them', async () => {
  const w = cleanWeights();
  w.weights[2 * 4] = 0.5;
  w.weights[4 * 4] = 1.25;
  const c = await stageCase(chainSkeleton(), await weightsNpz(w));
  try {
    const result = await applyRig(c);
    assertEquals(result.renormalizedVertices, 2);
    assertEquals(result.zeroWeightVertices, 0);
    const asset = await loadRiggedAsset(c.outPath);
    for (const v of [2, 4]) {
      const sum = asset.weights[v * 4] + asset.weights[v * 4 + 1] +
        asset.weights[v * 4 + 2] + asset.weights[v * 4 + 3];
      assertAlmostEquals(sum, 1, 1e-6);
    }
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig names the shape mismatch for a mis-shaped npz', async () => {
  const w = cleanWeights();
  const bad = await encodeNpz([
    { name: 'joints', dtype: 'uint16', shape: [VERTEX_COUNT, 4], data: w.joints },
    { name: 'weights', dtype: 'float32', shape: [VERTEX_COUNT - 1, 4], data: w.weights },
  ]);
  const c = await stageCase(chainSkeleton(), bad);
  try {
    assertMentions(
      await messageOf(() => applyRig(c)),
      'array "weights"',
      `shape [${VERTEX_COUNT - 1}, 4]`,
      `expected [${VERTEX_COUNT}, 4]`,
    );
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig lists what an npz holds when an array is missing', async () => {
  const w = cleanWeights();
  const bad = await encodeNpz([
    { name: 'skin_weights', dtype: 'float32', shape: [VERTEX_COUNT, 4], data: w.weights },
  ]);
  const c = await stageCase(chainSkeleton(), bad);
  try {
    assertMentions(await messageOf(() => applyRig(c)), '"joints"', 'skin_weights');
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig rejects float joint indices and integer weights', async () => {
  const w = cleanWeights();
  const floatJoints = await encodeNpz([
    { name: 'joints', dtype: 'float32', shape: [VERTEX_COUNT, 4], data: w.joints },
    { name: 'weights', dtype: 'float32', shape: [VERTEX_COUNT, 4], data: w.weights },
  ]);
  const a = await stageCase(chainSkeleton(), floatJoints);
  try {
    assertMentions(await messageOf(() => applyRig(a)), '"joints" is float32');
  } finally {
    await Deno.remove(a.dir, { recursive: true });
  }

  const intWeights = await encodeNpz([
    { name: 'joints', dtype: 'uint16', shape: [VERTEX_COUNT, 4], data: w.joints },
    { name: 'weights', dtype: 'uint8', shape: [VERTEX_COUNT, 4], data: w.weights },
  ]);
  const b = await stageCase(chainSkeleton(), intWeights);
  try {
    assertMentions(await messageOf(() => applyRig(b)), '"weights" is uint8', 'expected float32');
  } finally {
    await Deno.remove(b.dir, { recursive: true });
  }
});

Deno.test('applyRig rejects a skeleton that does not match the mesh', async () => {
  const skeleton = chainSkeleton({ vertexCount: 12 });
  const w = cleanWeights();
  const npz = await encodeNpz([
    { name: 'joints', dtype: 'uint16', shape: [12, 4], data: w.joints.subarray(0, 48) },
    { name: 'weights', dtype: 'float32', shape: [12, 4], data: w.weights.subarray(0, 48) },
  ]);
  const c = await stageCase(skeleton, npz);
  try {
    assertMentions(
      await messageOf(() => applyRig(c)),
      `has ${VERTEX_COUNT} vertices`,
      'declares 12',
    );
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig rejects duplicate joint names and out-of-order parents', async () => {
  const dup = chainSkeleton();
  dup.joints[2].name = 'bone_0';
  const a = await stageCase(dup);
  try {
    assertMentions(await messageOf(() => applyRig(a)), 'duplicate joint name "bone_0"', '0 and 2');
  } finally {
    await Deno.remove(a.dir, { recursive: true });
  }

  const unordered = chainSkeleton();
  unordered.joints[1].parent = 3;
  const b = await stageCase(unordered);
  try {
    assertMentions(
      await messageOf(() => applyRig(b)),
      'joint "bone_1" (index 1) has parent index 3',
      'parents must precede children',
    );
  } finally {
    await Deno.remove(b.dir, { recursive: true });
  }
});

Deno.test('applyRig refuses a mesh that is already rigged', async () => {
  const c = await stageCase();
  try {
    await applyRig(c);
    assertMentions(
      await messageOf(() => applyRig({ ...c, meshPath: c.outPath })),
      'already has a skin',
    );
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig rejects a skeleton file that is not a RigSkeleton', async () => {
  const c = await stageCase();
  try {
    await Deno.writeTextFile(c.skeletonPath, JSON.stringify({ joints: [] }));
    assertMentions(await messageOf(() => applyRig(c)), 'is not a RigSkeleton');
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('packWeightRows pads short rows and keeps the four heaviest', () => {
  const two = packWeightRows([0, 1, 2, 3], [0.5, 0.5, 0.25, 0.75], 2, 2, 4, 'pad');
  assertEquals([...two.joints], [0, 1, 0, 0, 2, 3, 0, 0]);
  assertEquals([...two.weights], [0.5, 0.5, 0, 0, 0.25, 0.75, 0, 0]);
  assertEquals(two.truncatedVertices, 0);

  const six = packWeightRows(
    [0, 1, 2, 3, 4, 0],
    [0.05, 0.4, 0.05, 0.3, 0.2, 0],
    1,
    6,
    5,
    'truncate',
  );
  assertEquals([...six.joints], [1, 3, 4, 0]); // 0.4, 0.3, 0.2, then 0.05 on joint 0
  assertEquals(six.truncatedVertices, 1);
  assertEquals(six.renormalizedVertices, 1);
  const sum = six.weights[0] + six.weights[1] + six.weights[2] + six.weights[3];
  assertAlmostEquals(sum, 1, 1e-6);
});

Deno.test('packWeightRows guards a zero row without dividing by zero', () => {
  const rows = packWeightRows([2, 0, 0, 0], [0, 0, 0, 0], 1, 4, 5, 'zero');
  assertEquals(rows.zeroWeightVertices, 1);
  assertEquals([...rows.joints], [0, 0, 0, 0]);
  assertEquals([...rows.weights], [1, 0, 0, 0]);
  assert(rows.weights.every(Number.isFinite));
});

Deno.test("applyRig points each joint's local +Y down its own bone", async () => {
  // the chain fixture is vertical, which is the one direction that cannot tell
  // an oriented frame from an identity one: bend it sideways, hang one bone
  // backwards (the antiparallel degenerate case), and disconnect bone_2's head
  // from bone_1's tail so the tail is the ONLY source of the direction
  const skeleton = chainSkeleton();
  skeleton.joints[1] = { name: 'bone_1', parent: 0, head: [0, 0.75, 0], tail: [0.75, 0.9, 0] };
  skeleton.joints[3] = { name: 'bone_3', parent: 2, head: [0, 2, 0], tail: [0, 1.5, 0] };
  const c = await stageCase(skeleton);
  try {
    await applyRig(c);
    const asset = await loadRiggedAsset(c.outPath);
    const worlds = restWorlds(asset);
    skeleton.joints.forEach((j, i) => {
      const d = [j.tail[0] - j.head[0], j.tail[1] - j.head[1], j.tail[2] - j.head[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      const world = worlds.subarray(i * 16, i * 16 + 16);
      // the joint's local +Y in world space is the head->tail direction, which
      // is what deformCheck reads back to choose a bend axis
      const recovered = boneDirection(world);
      for (let a = 0; a < 3; a++) {
        assertAlmostEquals(recovered[a], d[a] / len, 1e-6, `joint ${j.name} axis ${a}`);
      }
      // and the frame is still placed at the head
      for (let a = 0; a < 3; a++) {
        assertAlmostEquals(world[12 + a], j.head[a], 1e-6, `joint ${j.name} head ${a}`);
      }
    });

    // oriented frames must not disturb the bind: the rest pose still round-trips
    const mats = skinMatrices(worlds, asset.inverseBind, asset.jointCount);
    const skinned = skinAll(asset, mats);
    const original = tubePositions();
    for (let i = 0; i < original.length; i++) {
      assertAlmostEquals(skinned[i], original[i], 1e-5, `component ${i}`);
    }
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig is byte-deterministic for the same inputs', async () => {
  // the rigged glb is a cache input downstream (invariant 3 hashes inputs, and
  // this file IS the input to every bake that follows), so two runs over the
  // same three files have to produce the same bytes
  const c = await stageCase();
  try {
    await applyRig(c);
    const first = await Deno.readFile(c.outPath);
    await applyRig({ ...c, outPath: `${c.dir}/again.glb` });
    const second = await Deno.readFile(`${c.dir}/again.glb`);
    assertEquals(first.length, second.length);
    assert(first.every((b, i) => b === second[i]), 'rigged glb bytes differ between runs');
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('applyRig keeps the pin vertex bound to the leaf joint', async () => {
  const c = await stageCase();
  try {
    await applyRig(c);
    const asset = await loadRiggedAsset(c.outPath);
    assertEquals(asset.joints[PIN_VERTEX * 4], 4);
    assertAlmostEquals(asset.weights[PIN_VERTEX * 4], 1, 1e-6);
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});
