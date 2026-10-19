import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Orientation detection is a measurement, so it is testable exactly: build a
 * humanoid-ish body whose facing we KNOW, rotate it by a known angle, and
 * assert the detector recovers the rotation and that one verb undoes it.
 *
 * The body is deliberately crude (boxes) but carries the two cues the
 * detector claims to use: shoulders wider than the chest is deep, and feet
 * whose toes stick out the front. If the detector were secretly relying on
 * something else, this fixture would not satisfy it.
 */
import { assert, assertEquals } from '@std/assert';
import { Document, NodeIO } from '@gltf-transform/core';
import {
  applyOrientationFixes,
  boundsOf,
  detectFacing,
  detectFacingFile,
  worldPositions,
} from './dist/orient.js';

/** Axis-aligned box as 8 corners (enough for bounds + mass asymmetry). */
function box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): number[] {
  const out: number[] = [];
  for (const dx of [-0.5, 0.5]) {
    for (const dy of [-0.5, 0.5]) {
      for (const dz of [-0.5, 0.5]) {
        // repeat each corner so box volume roughly weights the mass sums
        for (let k = 0; k < 4; k++) out.push(cx + dx * sx, cy + dy * sy, cz + dz * sz);
      }
    }
  }
  return out;
}

/**
 * A +Z-facing humanoid: shoulders 0.5 m wide but only 0.2 m deep, and feet
 * whose toe boxes extend forward (+Z) of the ankle.
 */
function humanoidPositions(): Float32Array {
  return Float32Array.from([
    ...box(0, 1.45, 0, 0.22, 0.25, 0.22), // head
    ...box(0, 1.15, 0, 0.50, 0.35, 0.20), // shoulders: wide, shallow
    ...box(0, 0.85, 0, 0.36, 0.45, 0.20), // torso
    ...box(-0.12, 0.40, 0, 0.16, 0.60, 0.16), // legs
    ...box(0.12, 0.40, 0, 0.16, 0.60, 0.16),
    ...box(-0.12, 0.05, 0.09, 0.16, 0.10, 0.34), // feet: toes forward (+Z)
    ...box(0.12, 0.05, 0.09, 0.16, 0.10, 0.34),
  ]);
}

/** Rotate positions about +Y by degrees (same convention as the fixer). */
function rotateY(p: Float32Array, deg: number): Float32Array {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = c * x + s * z;
    out[i + 1] = y;
    out[i + 2] = -s * x + c * z;
  }
  return out;
}

async function writeGlb(
  path: string,
  positions: Float32Array,
  opts: { normal?: [number, number, number] } = {},
): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = doc.createAccessor('P').setType('VEC3')
    .setArray(positions as Float32Array<ArrayBuffer>)
    .setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', acc);
  if (opts.normal) {
    const n = new Float32Array(positions.length);
    for (let i = 0; i < n.length; i += 3) [n[i], n[i + 1], n[i + 2]] = opts.normal;
    prim.setAttribute(
      'NORMAL',
      doc.createAccessor('N').setType('VEC3').setArray(n).setBuffer(buffer),
    );
  }
  const mesh = doc.createMesh('m').addPrimitive(prim);
  doc.createScene('s').addChild(doc.createNode('n').setMesh(mesh));
  await fs.writeFile(path, await new NodeIO().writeBinary(doc));
}

test('facing: a +Z humanoid is recognised and needs no fix', () => {
  const r = detectFacing(humanoidPositions());
  assertEquals(r.facing, '+Z');
  assertEquals(r.suggestedFix, undefined, 'nothing to fix when already canonical');
  assert(r.confidence > 0.2, `confident enough to act on: ${r.confidence}`);
});

test('facing: every quarter-turn is detected with the verb that undoes it', () => {
  const base = humanoidPositions();
  for (
    const [deg, expectFacing, expectFix] of [
      [180, '-Z', 'rotate-180'],
      [90, '+X', 'rotate-90'],
      [270, '-X', 'rotate-270'],
    ] as Array<[number, string, string]>
  ) {
    const r = detectFacing(rotateY(base, deg));
    assertEquals(r.facing, expectFacing, `rotated ${deg} deg`);
    assertEquals(r.suggestedFix, expectFix, `suggested verb for ${deg} deg`);
  }
});

test('facing: a symmetric barrel reports low confidence instead of guessing', () => {
  // square cross-section, no front/back asymmetry: there IS no facing, and
  // saying so is better than rotating someone's asset on a coin flip
  const barrel = Float32Array.from(box(0, 0.5, 0, 0.4, 1.0, 0.4));
  const r = detectFacing(barrel);
  assert(r.confidence < 0.2, `low confidence on a barrel, got ${r.confidence}`);
});

test('ACCEPTANCE: a -Z mesh is fixed by ONE verb, and the geometry follows', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const backwards = `${dir}/backwards.glb`;
    const fixed = `${dir}/fixed.glb`;
    await writeGlb(backwards, rotateY(humanoidPositions(), 180));

    const before = await detectFacingFile(backwards);
    assertEquals(before.facing, '-Z', 'imported facing away from the camera');
    assertEquals(before.suggestedFix, 'rotate-180');

    // the single verb the report suggested
    const { facingAfter } = await applyOrientationFixes(backwards, fixed, [before.suggestedFix!]);
    assertEquals(facingAfter.facing, '+Z', 'one verb lands it on the canonical facing');

    // and the FILE really changed - a report that flips without the geometry
    // following would be the worst possible outcome here
    const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(fixed)));
    const p = worldPositions(doc);
    const b = boundsOf(p);
    const footCut = b.min[1] + (b.max[1] - b.min[1]) * 0.15;
    let toeZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i + 1] <= footCut) toeZ = Math.max(toeZ, p[i + 2]);
    }
    assert(toeZ > 0, `toes now point +Z in world space (max toe z = ${toeZ})`);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('face-front is idempotent and never rotates an already-correct mesh', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const a = `${dir}/a.glb`, b = `${dir}/b.glb`, c = `${dir}/c.glb`;
    await writeGlb(a, humanoidPositions());
    await applyOrientationFixes(a, b, ['face-front']);
    await applyOrientationFixes(b, c, ['face-front']);
    const first = await detectFacingFile(b);
    const second = await detectFacingFile(c);
    assertEquals(first.facing, '+Z');
    assertEquals(second.facing, '+Z');
    assertEquals(
      new Uint8Array(await fs.readFile(b)),
      new Uint8Array(await fs.readFile(c)),
      'a second face-front is a no-op, byte for byte',
    );
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('feet-ground and center place the body without fighting each other', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const src = `${dir}/floating.glb`;
    const out = `${dir}/placed.glb`;
    // lift and shove the body off-origin, then ask for both fixes
    const p = humanoidPositions();
    for (let i = 0; i < p.length; i += 3) {
      p[i] += 3;
      p[i + 1] += 5;
      p[i + 2] -= 2;
    }
    await writeGlb(src, p);
    await applyOrientationFixes(src, out, ['center', 'feet-ground']);

    const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(out)));
    const b = boundsOf(worldPositions(doc));
    assert(Math.abs(b.min[1]) < 1e-4, `feet on the ground plane (min y = ${b.min[1]})`);
    assert(Math.abs((b.min[0] + b.max[0]) / 2) < 1e-4, 'centred on X');
    assert(Math.abs((b.min[2] + b.max[2]) / 2) < 1e-4, 'centred on Z');
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

/** Positions as a SKINNED reader sees them: raw vertex data, no node transform. */
function vertexPositions(doc: Document): Float32Array {
  const out: number[] = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const a = prim.getAttribute('POSITION')?.getArray();
      if (a) out.push(...a);
    }
  }
  return Float32Array.from(out);
}

test('an orientation fix lands in the DATA, so skinning cannot discard it', async () => {
  // These fixes run on the canonical mesh moments before `applyRig` attaches a
  // skin, and the glTF spec says a skinned mesh node's transform no longer
  // places the mesh. A fix written only onto the node is therefore a fix that
  // evaporates: measured before this was baked, a body 1 m underground came
  // back with a node matrix of +1 and vertices still at -1, and `rig
  // --feet-ground` silently did nothing.
  //
  // Every other assertion in this file reads `worldPositions`, which applies
  // node transforms - which is exactly why they all passed while the verb did
  // not work. This one reads the vertices.
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const src = `${dir}/sunken.glb`;
    const out = `${dir}/grounded.glb`;
    const p = humanoidPositions();
    for (let i = 1; i < p.length; i += 3) p[i] -= 1; // shove the body underground
    await writeGlb(src, p);
    await applyOrientationFixes(src, out, ['feet-ground']);

    const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(out)));
    const b = boundsOf(vertexPositions(doc));
    assert(Math.abs(b.min[1]) < 1e-4, `feet at Y=0 in the VERTICES, got ${b.min[1]}`);
    for (const node of doc.getRoot().listNodes()) {
      if (!node.getMesh()) continue;
      const m = node.getWorldMatrix();
      for (let i = 0; i < 16; i++) {
        assert(
          Math.abs(m[i] - (i % 5 === 0 ? 1 : 0)) < 1e-6,
          'and the node is back at identity, so nothing applies the fix twice',
        );
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('a baked rotation keeps normals pointing where the faces do', async () => {
  // POSITION and NORMAL have to move together. A bake that transformed only
  // positions would light the character as though it had never turned - and
  // nothing else in this file would notice, because facing is measured from
  // positions alone.
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const src = `${dir}/facing.glb`;
    const out = `${dir}/turned.glb`;
    await writeGlb(src, humanoidPositions(), { normal: [0, 0, 1] });
    await applyOrientationFixes(src, out, ['rotate-90']);

    const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(out)));
    const n = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('NORMAL')!.getArray()!;
    // rotate-90 takes +Z to +X (yawMatrix's stated convention)
    assert(Math.abs(n[0] - 1) < 1e-5, `normal x -> 1, got ${n[0]}`);
    assert(Math.abs(n[1]) < 1e-5, `normal y -> 0, got ${n[1]}`);
    assert(Math.abs(n[2]) < 1e-5, `normal z -> 0, got ${n[2]}`);
    assert(
      Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-5,
      'and it is still a unit vector',
    );
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
