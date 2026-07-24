/**
 * fitCanonicalBody is a writer whose whole value is a NUMBER being right, so
 * the assertions are about the file it wrote, re-read from disk, and about the
 * FitResult being honest rather than flattering:
 *
 * - the fitted body is the target's height, and every joint moved with the skin
 *   (a fit that scaled vertices and left the skeleton behind passes every
 *   visual check and breaks every pose);
 * - X follows the target's silhouette bands rather than the height, which is
 *   the whole reason bands exist;
 * - the body's own weights survive intact — Track A's entire premise;
 * - the rest pose round-trips through the REBUILT inverse bind matrices, which
 *   is what catches forgetting that moved joints need new ones;
 * - a torn fit NAMES the joints that fell outside instead of writing silently;
 * - and the surface error is 0 against an identical target and greater than 0
 *   against a different one. Either half alone can be faked; together they
 *   cannot.
 */
import { assert, assertAlmostEquals, assertEquals, assertGreater } from 'jsr:@std/assert@1';
import { NodeIO } from '@gltf-transform/core';
import { CanonicalBodySchema, parseWith } from '@spritebook/schema';
import { UAL_HUMANOID } from '../anim/profile.ts';
import {
  BODY,
  BODY_META,
  BROAD,
  buildBodyGlb,
  buildBoxGlb,
  buildTargetGlb,
  CHUNKY,
  type FitCase,
  stageFitCase,
  TALL,
} from './_fit_fixtures.ts';
import {
  buildCanonicalBody,
  closestOnTriangle,
  fitCanonicalBody,
  type FitReport,
  readSurface,
  TriangleGrid,
} from './fit.ts';
import { boundsOf } from './orient.ts';
import { loadRiggedAsset, restWorlds, type RiggedAsset, skinAll, skinMatrices } from './skin.ts';

/** Stage a case, build the canonical body, fit it, and hand back everything. */
async function fitTo(
  target: Uint8Array,
  bodyBytes?: Uint8Array,
): Promise<{ c: FitCase; report: FitReport; fitted: RiggedAsset; source: RiggedAsset }> {
  const c = await stageFitCase(target, bodyBytes);
  await buildCanonicalBody({ sourcePath: c.sourcePath, outDir: `${c.dir}/body`, ...BODY_META });
  const source = await loadRiggedAsset(c.bodyPath);
  const report = await fitCanonicalBody({
    bodyPath: c.bodyPath,
    bodyManifestPath: c.bodyManifestPath,
    targetPath: c.targetPath,
    outPath: c.outPath,
  });
  return { c, report, fitted: await loadRiggedAsset(c.outPath), source };
}

/** World-space Y of a joint's rest position. */
function jointY(asset: RiggedAsset, name: string): number {
  const i = asset.jointNames.indexOf(name);
  assert(i >= 0, `joint "${name}" not in [${asset.jointNames.join(', ')}]`);
  return restWorlds(asset)[i * 16 + 13];
}

async function messageOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected the call to throw');
}

function assertMentions(message: string, ...needles: string[]): void {
  for (const n of needles) assert(message.includes(n), `expected "${n}" in: ${message}`);
}

Deno.test('fitCanonicalBody matches a taller target, and the joints scale with it', async () => {
  const { c, report, fitted, source } = await fitTo(await buildTargetGlb(TALL));
  try {
    const targetBounds = boundsOf(
      (await new NodeIO().readBinary(await Deno.readFile(c.targetPath)))
        .getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION')!
        .getArray() as Float32Array,
    );
    const targetHeight = targetBounds.max[1] - targetBounds.min[1];
    const fittedBounds = boundsOf(fitted.positions);
    const sourceBounds = boundsOf(source.positions);

    assertAlmostEquals(report.heightM, targetHeight, 1e-6, 'reported height is the target height');
    assertAlmostEquals(
      fittedBounds.max[1] - fittedBounds.min[1],
      targetHeight,
      1e-3,
      'the fitted body stands as tall as the target',
    );
    // feet land on the target's ground plane, not on the body's old one (D-012)
    assertAlmostEquals(fittedBounds.min[1], targetBounds.min[1], 1e-3, 'feet on the target floor');

    // the joints moved WITH the skin: a known joint's height above the floor
    // scaled by exactly the reported Y scale
    const before = jointY(source, 'Head') - sourceBounds.min[1];
    const after = jointY(fitted, 'Head') - fittedBounds.min[1];
    assertAlmostEquals(after, before * report.scale[1], 1e-5, 'Head rose with the body');
    assertGreater(report.scale[1], 1.2, 'a taller target means a scale above 1');
    for (const name of ['pelvis', 'foot_l', 'hand_r']) {
      const b = jointY(source, name) - sourceBounds.min[1];
      assertAlmostEquals(
        jointY(fitted, name) - fittedBounds.min[1],
        b * report.scale[1],
        1e-5,
        `${name} scaled with the body`,
      );
    }
    assertEquals(report.strayJoints, []);
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('fitCanonicalBody takes X from the target bands, not from a uniform scale', async () => {
  const { c, report, fitted, source } = await fitTo(await buildTargetGlb(BROAD));
  try {
    const target = boundsOf(
      (await new NodeIO().readBinary(await Deno.readFile(c.targetPath)))
        .getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION')!
        .getArray() as Float32Array,
    );
    const targetX = target.max[0] - target.min[0];
    const bodyX = boundsOf(source.positions).max[0] - boundsOf(source.positions).min[0];
    const fittedX = boundsOf(fitted.positions).max[0] - boundsOf(fitted.positions).min[0];

    // BROAD is twice as wide at the same height: a uniform fit would leave X
    // where it was, and this is the number that proves the bands ran
    assertGreater(report.scale[0], 1.8, 'X scaled up for a broad target');
    assert(report.scale[1] < 1.1, `Y stayed near 1, got ${report.scale[1]}`);
    assertGreater(
      report.scale[0] / report.scale[1],
      1.7,
      'the fit is non-uniform: X did not follow the height',
    );
    assert(
      Math.abs(fittedX - targetX) < Math.abs(bodyX - targetX) * 0.1,
      `fitted X ${fittedX} should track the target's ${targetX}, not the body's ${bodyX}`,
    );
    assertEquals(report.strayJoints, []);
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test("fitCanonicalBody preserves the body's own weights and skin", async () => {
  const { c, report, fitted, source } = await fitTo(await buildTargetGlb(CHUNKY));
  try {
    const doc = await new NodeIO().readBinary(await Deno.readFile(c.outPath));
    assertEquals(doc.getRoot().listSkins().length, 1, 'exactly one skin');
    assertEquals(doc.getRoot().listSkins()[0].listJoints().length, source.jointCount);
    assertEquals(fitted.vertexCount, source.vertexCount, 'topology is untouched');
    assertEquals(report.renormalizedVertices, 0, 'clean authored weights need no repair');

    for (let v = 0; v < fitted.vertexCount; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const j = fitted.joints[v * 4 + k];
        assert(j < fitted.jointCount, `vertex ${v} slot ${k} joint index ${j}`);
        sum += fitted.weights[v * 4 + k];
      }
      assertAlmostEquals(sum, 1, 1e-5, `vertex ${v} weights sum`);
      // the weights are the body's OWN, vertex for vertex — Track A's premise
      for (let k = 0; k < 4; k++) {
        assertAlmostEquals(fitted.weights[v * 4 + k], source.weights[v * 4 + k], 1e-6);
        assertEquals(fitted.joints[v * 4 + k], source.joints[v * 4 + k]);
      }
    }

    // UVs and the texture ride through untouched: identity is UV-space
    const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    const uv = prim.getAttribute('TEXCOORD_0');
    assert(uv, 'TEXCOORD_0 survived the fit');
    assertEquals(uv!.getCount(), source.vertexCount);
    assert(prim.getMaterial()?.getBaseColorTexture(), 'the base colour texture survived');
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('fitCanonicalBody round-trips the fitted rest pose through its new IBMs', async () => {
  const { c, fitted } = await fitTo(await buildTargetGlb(TALL));
  try {
    const mats = skinMatrices(restWorlds(fitted), fitted.inverseBind, fitted.jointCount);
    const skinned = skinAll(fitted, mats);
    assertEquals(skinned.length, fitted.positions.length);
    for (let i = 0; i < skinned.length; i++) {
      assertAlmostEquals(skinned[i], fitted.positions[i], 1e-5, `component ${i}`);
    }
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('fitCanonicalBody NAMES the joints a torn fit pushed outside the target', async () => {
  // a barrel with no arms: the bands read a torso where the body has a waist,
  // the fit widens it to match, and the arms end up outside the mesh entirely
  const blob = await buildTargetGlb({ ...BODY, width: 0.7, thick: 0.1 }, { withoutArms: true });
  const { c, report, fitted } = await fitTo(blob);
  try {
    assertGreater(report.strayJoints.length, 0, 'the tear is reported, not written silently');
    for (const name of ['hand_l', 'hand_r']) {
      assert(
        report.strayJoints.includes(name),
        `expected "${name}" in [${report.strayJoints.join(', ')}]`,
      );
    }
    // every named joint really is outside, and every unnamed one really is in
    const target = boundsOf(
      (await new NodeIO().readBinary(await Deno.readFile(c.targetPath)))
        .getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION')!
        .getArray() as Float32Array,
    );
    const worlds = restWorlds(fitted);
    const tol = (target.max[1] - target.min[1]) * 0.01;
    fitted.jointNames.forEach((name, i) => {
      const outside = [0, 1, 2].some((a) =>
        worlds[i * 16 + 12 + a] < target.min[a] - tol ||
        worlds[i * 16 + 12 + a] > target.max[a] + tol
      );
      assertEquals(report.strayJoints.includes(name), outside, `${name} stray classification`);
    });
    // and it is still a file someone can open to see what went wrong
    assertEquals(
      (await new NodeIO().readBinary(await Deno.readFile(c.outPath)))
        .getRoot().listSkins().length,
      1,
    );
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('fitCanonicalBody reports the surface error honestly', async () => {
  const same = await fitTo(await buildTargetGlb(BODY));
  try {
    // fitted to its own shape, the error really is zero — the baseline that
    // makes the non-zero reading below meaningful
    assertEquals(same.report.meanSurfaceErrorM, 0);
    assertEquals(same.report.maxSurfaceErrorM, 0);
    assertEquals(same.report.scale.map((s) => Math.round(s * 1e6) / 1e6), [1, 1, 1]);
  } finally {
    await Deno.remove(same.c.dir, { recursive: true });
  }

  const other = await fitTo(await buildTargetGlb(CHUNKY));
  try {
    const { meanSurfaceErrorM: mean, maxSurfaceErrorM: max } = other.report;
    assert(Number.isFinite(mean) && Number.isFinite(max), `error must be finite: ${mean}, ${max}`);
    assertGreater(mean, 0, 'a different shape cannot be matched exactly, and saying so is the job');
    assertGreater(max, mean, 'the worst vertex is worse than the average one');
  } finally {
    await Deno.remove(other.c.dir, { recursive: true });
  }
});

Deno.test('fitCanonicalBody keeps vertices the target cannot reach, and counts them', async () => {
  // a 0.3 m cube: most of a humanoid has no target surface anywhere near it
  const { c, report, fitted } = await fitTo(await buildBoxGlb(0.3, 0.3, 0.3));
  try {
    assertGreater(report.unprojectedVertices, 0, 'unreachable vertices are counted');
    assert(report.unprojectedVertices < fitted.vertexCount, 'but not all of them');
    for (let i = 0; i < fitted.positions.length; i++) {
      assert(Number.isFinite(fitted.positions[i]), `component ${i} is finite, never stretched`);
    }
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('TriangleGrid finds the same nearest point brute force does', async () => {
  // the reported surface error is only as honest as the search that produced
  // it, so the acceleration structure is checked against the definition
  const dir = await Deno.makeTempDir({ prefix: 'spritebook-grid-' });
  try {
    const path = `${dir}/target.glb`;
    await Deno.writeFile(path, await buildTargetGlb(CHUNKY));
    const surface = readSurface(
      await new NodeIO().readBinary(await Deno.readFile(path)),
      'grid test',
    );
    const grid = new TriangleGrid(surface);
    const triangles = surface.indices.length / 3;

    // a deterministic lattice of probes: inside the mesh, on it, and well
    // outside it (where a ring search is easiest to get wrong)
    const hit: [number, number, number] = [0, 0, 0];
    const brute: [number, number, number] = [0, 0, 0];
    const best: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        for (let k = 0; k < 5; k++) {
          const p: [number, number, number] = [
            -1.2 + (i * 2.4) / 4,
            -0.4 + (j * 2.2) / 4,
            -1.2 + (k * 2.4) / 4,
          ];
          const got = grid.nearest(p, hit);
          let want = Infinity;
          for (let t = 0; t < triangles; t++) {
            const d2 = closestOnTriangle(
              p,
              surface.positions,
              surface.indices[t * 3] * 3,
              surface.indices[t * 3 + 1] * 3,
              surface.indices[t * 3 + 2] * 3,
              brute,
            );
            if (d2 < want) {
              want = d2;
              best[0] = brute[0], best[1] = brute[1], best[2] = brute[2];
            }
          }
          assertAlmostEquals(got, Math.sqrt(want), 1e-6, `probe ${i},${j},${k} distance`);
          for (let a = 0; a < 3; a++) {
            assertAlmostEquals(hit[a], best[a], 1e-6, `probe ${i},${j},${k} component ${a}`);
          }
        }
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// buildCanonicalBody
// ---------------------------------------------------------------------------

Deno.test('buildCanonicalBody derives regions covering every core UAL joint', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'spritebook-body-' });
  try {
    const sourcePath = `${dir}/source.glb`;
    await Deno.writeFile(sourcePath, await buildBodyGlb());
    const built = await buildCanonicalBody({
      sourcePath,
      outDir: `${dir}/out`,
      ...BODY_META,
      heightM: 1.75,
    });

    // it is schema-valid as WRITTEN, not just as returned
    const onDisk = parseWith(
      CanonicalBodySchema,
      JSON.parse(await Deno.readTextFile(built.manifestPath)),
      'written body.json',
    );
    assertEquals(onDisk, built.body);
    assertEquals(onDisk.skeleton, 'ual-humanoid');
    assertEquals(onDisk.id, BODY_META.id);
    assertEquals(onDisk.heightM, 1.75);
    assertGreater(onDisk.vertexCount, 0);
    assertEquals(onDisk.jointCount, UAL_HUMANOID.core.length);

    const covered = new Set(onDisk.regions.flatMap((r) => r.joints));
    for (const joint of UAL_HUMANOID.core) {
      assert(covered.has(joint), `core joint "${joint}" belongs to no region`);
    }
    assertEquals(covered.size, UAL_HUMANOID.core.length, 'no region invents a joint');

    const side = (id: string) => onDisk.regions.find((r) => r.id === id)?.side;
    assertEquals(side('arm-l'), 'left');
    assertEquals(side('hand-l'), 'left');
    assertEquals(side('leg-r'), 'right');
    assertEquals(side('foot-r'), 'right');
    assertEquals(side('torso'), 'center');
    assertEquals(side('head'), 'center');

    for (const r of onDisk.regions) {
      assertGreater(r.uvRect.w, 0, `region "${r.id}" has an empty UV island`);
      assertGreater(r.uvRect.h, 0, `region "${r.id}" has an empty UV island`);
      assert(r.uvRect.x + r.uvRect.w <= 1 + 1e-6, `region "${r.id}" runs off the atlas page`);
      assert(r.uvRect.y + r.uvRect.h <= 1 + 1e-6, `region "${r.id}" runs off the atlas page`);
    }
    // left and right are separately addressable, or D-008's mirroring is a lie
    const l = onDisk.regions.find((r) => r.id === 'hand-l')!.uvRect;
    const r = onDisk.regions.find((r) => r.id === 'hand-r')!.uvRect;
    assert(l.x !== r.x || l.y !== r.y, 'the two hands share a UV island');

    // the glb is the source bytes, so its hash is the artist's, not our writer's
    assertEquals(
      await Deno.readFile(built.glbPath),
      await Deno.readFile(sourcePath),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('buildCanonicalBody refuses a source without UVs, and names the fix', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'spritebook-body-' });
  try {
    const sourcePath = `${dir}/source.glb`;
    await Deno.writeFile(sourcePath, await buildBodyGlb(BODY, { withoutUvs: true }));
    const message = await messageOf(() =>
      buildCanonicalBody({ sourcePath, outDir: `${dir}/out`, ...BODY_META })
    );
    assertMentions(message, 'TEXCOORD_0', 'UV-unwrap', 'unwrap the source');
    await Deno.stat(`${dir}/out`).then(
      () => {
        throw new Error('nothing should have been written');
      },
      () => {},
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('buildCanonicalBody reports what a non-UAL source is missing', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'spritebook-body-' });
  try {
    const sourcePath = `${dir}/source.glb`;
    await Deno.writeFile(
      sourcePath,
      await buildBodyGlb(BODY, { omitJoints: ['clavicle_l', 'neck_01'] }),
    );
    const message = await messageOf(() =>
      buildCanonicalBody({ sourcePath, outDir: `${dir}/out`, ...BODY_META })
    );
    assertMentions(message, 'clavicle_l', 'neck_01', 'core UAL joint');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('buildCanonicalBody refuses an unrigged source', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'spritebook-body-' });
  try {
    const sourcePath = `${dir}/source.glb`;
    await Deno.writeFile(sourcePath, await buildBodyGlb(BODY, { withoutSkin: true }));
    const message = await messageOf(() =>
      buildCanonicalBody({ sourcePath, outDir: `${dir}/out`, ...BODY_META })
    );
    assertMentions(message, 'no skin', 'rig the source');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('fitCanonicalBody rejects a manifest from a different build', async () => {
  const c = await stageFitCase(await buildTargetGlb(BODY));
  try {
    const built = await buildCanonicalBody({
      sourcePath: c.sourcePath,
      outDir: `${c.dir}/body`,
      ...BODY_META,
    });
    await Deno.writeTextFile(
      c.bodyManifestPath,
      JSON.stringify({ ...built.body, vertexCount: built.body.vertexCount + 1 }),
    );
    const message = await messageOf(() =>
      fitCanonicalBody({
        bodyPath: c.bodyPath,
        bodyManifestPath: c.bodyManifestPath,
        targetPath: c.targetPath,
        outPath: c.outPath,
      })
    );
    assertMentions(message, 'different builds', 'rebuild the canonical body');
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('fitCanonicalBody honours a declared target height', async () => {
  const c = await stageFitCase(await buildTargetGlb(BODY));
  try {
    await buildCanonicalBody({ sourcePath: c.sourcePath, outDir: `${c.dir}/body`, ...BODY_META });
    const report = await fitCanonicalBody({
      bodyPath: c.bodyPath,
      bodyManifestPath: c.bodyManifestPath,
      targetPath: c.targetPath,
      outPath: c.outPath,
      heightM: 1.8,
    });
    assertAlmostEquals(report.heightM, 1.8, 1e-6);
    const fitted = await loadRiggedAsset(c.outPath);
    const b = boundsOf(fitted.positions);
    assertAlmostEquals(b.max[1] - b.min[1], 1.8, 1e-3, 'the body stands at the declared height');
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});
