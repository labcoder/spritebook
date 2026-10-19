import { promises as fs } from 'node:fs';
import { test } from 'node:test';
/**
 * Profile + loader validation (P3-T1). The profile is checked against the REAL
 * UAL subset fixture, never against itself: `core` must be exactly the
 * 21-joint fixture body, `extended` must be exactly the remaining UAL track
 * names. Loader checks follow the animation-retargeting skill: numeric
 * validation (unit quats, hemisphere continuity, exact counts), actionable
 * errors for the unsupported (CUBICSPLINE, mixed interpolation modes).
 */
import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { Document, NodeIO } from '@gltf-transform/core';
import { loadClip, loadSkeletonRest, UAL_HUMANOID } from './dist/profile.js';
import { qAngle, qFromMat4, type Quat } from './dist/quat.js';

const io = new NodeIO();
const FIXTURES = new URL('./fixtures/', import.meta.url);

async function readDoc(name: string): Promise<Document> {
  return await io.readBinary(new Uint8Array(await fs.readFile(new URL(name, FIXTURES))));
}

let ualP: Promise<Document> | undefined;
function ualDoc(): Promise<Document> {
  ualP ??= readDoc('ual-subset.glb');
  return ualP;
}

/** The 21-joint fixture body (alphabetical) — the acceptance list, spelled out. */
const CORE_21 = [
  'Head',
  'calf_l',
  'calf_r',
  'clavicle_l',
  'clavicle_r',
  'foot_l',
  'foot_r',
  'hand_l',
  'hand_r',
  'lowerarm_l',
  'lowerarm_r',
  'neck_01',
  'pelvis',
  'root',
  'spine_01',
  'spine_02',
  'spine_03',
  'thigh_l',
  'thigh_r',
  'upperarm_l',
  'upperarm_r',
];

test('UAL_HUMANOID: core is exactly the 21-joint fixture body', () => {
  assertEquals(UAL_HUMANOID.id, 'ual-humanoid');
  assertEquals([...UAL_HUMANOID.core].sort(), CORE_21);
  assertEquals(new Set(UAL_HUMANOID.core).size, 21);
  assertEquals(UAL_HUMANOID.hips, 'pelvis');
  assertEquals([...UAL_HUMANOID.feet].sort(), ['foot_l', 'foot_r']);
  assert(UAL_HUMANOID.core.includes(UAL_HUMANOID.hips), 'hips is a core joint');
  for (const f of UAL_HUMANOID.feet) assert(UAL_HUMANOID.core.includes(f), `${f} is a core joint`);
  const coreSet = new Set(UAL_HUMANOID.core);
  assertEquals(UAL_HUMANOID.extended.length, 44);
  assertEquals(new Set(UAL_HUMANOID.extended).size, 44);
  for (const j of UAL_HUMANOID.extended) {
    assert(!coreSet.has(j), `${j} appears in both core and extended`);
  }
});

test('UAL_HUMANOID: extended is exactly the remaining UAL joints (fixture-derived)', async () => {
  const clip = loadClip(await ualDoc(), 'Walk_Loop', 'walk');
  const coreSet = new Set(UAL_HUMANOID.core);
  const remaining = [...clip.tracks.keys()].filter((n) => !coreSet.has(n)).sort();
  assertEquals([...UAL_HUMANOID.extended].sort(), remaining);
  for (const j of UAL_HUMANOID.core) {
    assert(clip.tracks.has(j), `core joint ${j} missing from the UAL skeleton`);
  }
});

test('UAL_HUMANOID: side pairs are explicit, left first, covering every sided joint', () => {
  const all = new Set([...UAL_HUMANOID.core, ...UAL_HUMANOID.extended]);
  const seen = new Set<string>();
  for (const [l, r] of UAL_HUMANOID.sidePairs) {
    assert(l.endsWith('_l'), `${l}: left anchor must end in _l`);
    assert(r.endsWith('_r'), `${r}: right anchor must end in _r`);
    assertEquals(l.slice(0, -2), r.slice(0, -2), `${l}/${r}: pair stems must match`);
    assert(all.has(l), `${l} is not a profile joint`);
    assert(all.has(r), `${r} is not a profile joint`);
    assert(!seen.has(l) && !seen.has(r), `${l}/${r} anchored twice`);
    seen.add(l);
    seen.add(r);
  }
  const sided = [...all].filter((j) => j.endsWith('_l') || j.endsWith('_r'));
  assertEquals(seen.size, sided.length, 'every sided joint is anchored exactly once');
  assertEquals(UAL_HUMANOID.sidePairs.length, 29);
});

test('loadSkeletonRest: UAL subset keeps 65 joints + the Armature wrapper, hierarchy intact', async () => {
  const rest = loadSkeletonRest(await ualDoc());
  assertEquals(rest.locals.size, 66);
  assertEquals(rest.parents.get('Armature'), '');
  assertEquals(rest.parents.get('root'), 'Armature');
  assertEquals(rest.parents.get('pelvis'), 'root');
  assertEquals(rest.parents.get('calf_l'), 'thigh_l');
  assertEquals(rest.parents.get('index_01_l'), 'hand_l');
  for (const j of [...UAL_HUMANOID.core, ...UAL_HUMANOID.extended]) {
    const m = rest.locals.get(j);
    assert(m, `missing joint ${j}`);
    assertEquals(m.length, 16, `${j}: column-major mat4`);
  }
});

test('loadSkeletonRest: fixture humanoids expose exactly the 21 core joints (mesh node excluded)', async () => {
  for (
    const name of ['humanoid-normal.glb', 'humanoid-tall-thin.glb', 'humanoid-short-chunky.glb']
  ) {
    const rest = loadSkeletonRest(await readDoc(name));
    assertEquals([...rest.locals.keys()].sort(), CORE_21, name);
    assertEquals(rest.parents.get('root'), '', name);
    assertEquals(rest.parents.get('pelvis'), 'root', name);
  }
  const normal = loadSkeletonRest(await readDoc('humanoid-normal.glb'));
  const pelvis = normal.locals.get('pelvis')!;
  assertAlmostEquals(pelvis[13], 0.9, 1e-6, 'translation lives in m[12..14] (column-major)');
});

test('loadClip: Walk_Loop — duration ~1.33 s, 65 joint tracks, unit continuous quats', async () => {
  const clip = loadClip(await ualDoc(), 'Walk_Loop', 'walk');
  assertEquals(clip.id, 'walk');
  assertAlmostEquals(clip.duration, 1.3333334, 1e-3);
  assertEquals(clip.tracks.size, 65);
  for (const [name, tr] of clip.tracks) {
    assertEquals(tr.interpolation, 'LINEAR', name);
    for (let i = 1; i < tr.times.length; i++) {
      assert(tr.times[i] > tr.times[i - 1], `${name}: times strictly ascending`);
    }
    assert(tr.rotations, `${name}: UAL keys every joint`);
    assertEquals(tr.rotations!.length, tr.times.length * 4, name);
    for (let i = 0; i < tr.times.length; i++) {
      const q = tr.rotations!.subarray(i * 4, i * 4 + 4);
      assertAlmostEquals(Math.hypot(q[0], q[1], q[2], q[3]), 1, 1e-3, `${name}[${i}]: unit quat`);
      if (i > 0) {
        const p = tr.rotations!.subarray((i - 1) * 4, i * 4);
        const dot = q[0] * p[0] + q[1] * p[1] + q[2] * p[2] + q[3] * p[3];
        assert(dot >= 0, `${name}[${i}]: hemisphere-continuous`);
      }
    }
    if (tr.translations) assertEquals(tr.translations.length, tr.times.length * 3, name);
    if (tr.scales) assertEquals(tr.scales.length, tr.times.length * 3, name);
  }
  const pelvis = clip.tracks.get('pelvis')!;
  assert(pelvis.translations, 'pelvis carries the hip translation track');
  assertEquals(pelvis.times.length, 41, '30 fps x 1.333 s union grid');
  assertEquals(pelvis.times[0], 0);
});

test('loadClip: A_TPose parses and matches the source rest pose (bind pose = T-pose)', async () => {
  const doc = await ualDoc();
  const clip = loadClip(doc, 'A_TPose', 'tpose');
  assertAlmostEquals(clip.duration, 2.5, 1e-6);
  assertEquals(clip.tracks.size, 65);
  const rest = loadSkeletonRest(doc);
  for (const [name, tr] of clip.tracks) {
    const m = rest.locals.get(name)!;
    const rq = qFromMat4(m);
    const q: Quat = [tr.rotations![0], tr.rotations![1], tr.rotations![2], tr.rotations![3]];
    // measured max deviation 4.6e-4 rad (ring_03_l)
    assert(qAngle(q, rq) < 0.01, `${name}: A_TPose rotation deviates from rest`);
    const d = Math.hypot(
      tr.translations![0] - m[12],
      tr.translations![1] - m[13],
      tr.translations![2] - m[14],
    );
    assert(d < 1e-4, `${name}: A_TPose translation deviates from rest`);
  }
});

test('loadClip: unknown animation name throws, listing what exists', async () => {
  const doc = await ualDoc();
  const err = assertThrows(() => loadClip(doc, 'Run_Loop', 'run'), Error, 'not found');
  assert(err.message.includes('Walk_Loop'), 'lists Walk_Loop');
  assert(err.message.includes('A_TPose'), 'lists A_TPose');
});

/** Minimal in-memory animation: rotation sampler + optional translation sampler. */
function synthDoc(
  rotInterp: 'LINEAR' | 'CUBICSPLINE',
  transInterp?: 'STEP',
): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const node = doc.createNode('pelvis');
  doc.createScene('scene').addChild(node);
  const anim = doc.createAnimation('synth');
  const input = doc.createAccessor().setType('SCALAR')
    .setArray(new Float32Array([0, 1])).setBuffer(buffer);
  const rotOut = doc.createAccessor().setType('VEC4')
    .setArray(
      rotInterp === 'CUBICSPLINE'
        ? new Float32Array(2 * 3 * 4) // in-tangent, value, out-tangent per key
        : new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
    ).setBuffer(buffer);
  const rotSampler = doc.createAnimationSampler()
    .setInput(input).setOutput(rotOut).setInterpolation(rotInterp);
  const rotChannel = doc.createAnimationChannel()
    .setTargetNode(node).setTargetPath('rotation').setSampler(rotSampler);
  anim.addSampler(rotSampler).addChannel(rotChannel);
  if (transInterp) {
    const tOut = doc.createAccessor().setType('VEC3')
      .setArray(new Float32Array(6)).setBuffer(buffer);
    const tSampler = doc.createAnimationSampler()
      .setInput(input).setOutput(tOut).setInterpolation(transInterp);
    const tChannel = doc.createAnimationChannel()
      .setTargetNode(node).setTargetPath('translation').setSampler(tSampler);
    anim.addSampler(tSampler).addChannel(tChannel);
  }
  return doc;
}

test('loadClip: CUBICSPLINE is an actionable error, never a silent fallback', () => {
  const err = assertThrows(
    () => loadClip(synthDoc('CUBICSPLINE'), 'synth', 'x'),
    Error,
    'CUBICSPLINE',
  );
  assert(err.message.includes('pelvis'), 'names the joint');
  assert(err.message.includes('resample'), 'says how to fix it');
});

test('loadClip: a joint mixing LINEAR and STEP paths is an actionable error', () => {
  const err = assertThrows(
    () => loadClip(synthDoc('LINEAR', 'STEP'), 'synth', 'x'),
    Error,
    'mixes',
  );
  assert(err.message.includes('pelvis'), 'names the joint');
});
