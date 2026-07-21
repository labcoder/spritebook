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
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { Document, NodeIO } from '@gltf-transform/core';
import {
  applyOrientationFixes,
  boundsOf,
  detectFacing,
  detectFacingFile,
  worldPositions,
} from './orient.ts';

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

async function writeGlb(path: string, positions: Float32Array): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = doc.createAccessor('P').setType('VEC3')
    .setArray(positions as Float32Array<ArrayBuffer>)
    .setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', acc);
  const mesh = doc.createMesh('m').addPrimitive(prim);
  doc.createScene('s').addChild(doc.createNode('n').setMesh(mesh));
  await Deno.writeFile(path, await new NodeIO().writeBinary(doc));
}

Deno.test('facing: a +Z humanoid is recognised and needs no fix', () => {
  const r = detectFacing(humanoidPositions());
  assertEquals(r.facing, '+Z');
  assertEquals(r.suggestedFix, undefined, 'nothing to fix when already canonical');
  assert(r.confidence > 0.2, `confident enough to act on: ${r.confidence}`);
});

Deno.test('facing: every quarter-turn is detected with the verb that undoes it', () => {
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

Deno.test('facing: a symmetric barrel reports low confidence instead of guessing', () => {
  // square cross-section, no front/back asymmetry: there IS no facing, and
  // saying so is better than rotating someone's asset on a coin flip
  const barrel = Float32Array.from(box(0, 0.5, 0, 0.4, 1.0, 0.4));
  const r = detectFacing(barrel);
  assert(r.confidence < 0.2, `low confidence on a barrel, got ${r.confidence}`);
});

Deno.test('ACCEPTANCE: a -Z mesh is fixed by ONE verb, and the geometry follows', async () => {
  const dir = await Deno.makeTempDir();
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
    const doc = await new NodeIO().readBinary(await Deno.readFile(fixed));
    const p = worldPositions(doc);
    const b = boundsOf(p);
    const footCut = b.min[1] + (b.max[1] - b.min[1]) * 0.15;
    let toeZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i + 1] <= footCut) toeZ = Math.max(toeZ, p[i + 2]);
    }
    assert(toeZ > 0, `toes now point +Z in world space (max toe z = ${toeZ})`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('face-front is idempotent and never rotates an already-correct mesh', async () => {
  const dir = await Deno.makeTempDir();
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
      await Deno.readFile(b),
      await Deno.readFile(c),
      'a second face-front is a no-op, byte for byte',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('feet-ground and center place the body without fighting each other', async () => {
  const dir = await Deno.makeTempDir();
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

    const doc = await new NodeIO().readBinary(await Deno.readFile(out));
    const b = boundsOf(worldPositions(doc));
    assert(Math.abs(b.min[1]) < 1e-4, `feet on the ground plane (min y = ${b.min[1]})`);
    assert(Math.abs((b.min[0] + b.max[0]) / 2) < 1e-4, 'centred on X');
    assert(Math.abs((b.min[2] + b.max[2]) / 2) < 1e-4, 'centred on Z');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
