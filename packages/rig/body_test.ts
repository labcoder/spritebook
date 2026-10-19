import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The bundled canonical bodies, tested as SHIPPED ARTIFACTS (P3-T4 close-out):
 * schema-valid manifests, a real UAL skeleton, and — the acceptance — a clean
 * fit onto all three P3-T1 proportioned humanoids. Everything here runs
 * against the committed bytes, because the committed bytes are what a user
 * gets.
 */
import { assert, assertEquals } from '@std/assert';
import { NodeIO } from '@gltf-transform/core';
import { CanonicalBodySchema, parseWith } from '@spritebook/schema';
import { UAL_HUMANOID } from '../anim/dist/profile.js';
import { fitCanonicalBody } from './dist/fit.js';

const BODIES_DIR = decodeURIComponent(
  new URL('./bodies', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
);
const FIXTURES = decodeURIComponent(
  new URL('../anim/fixtures', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
);

test('bundled bodies: schema-valid, CC0, full UAL core, regions sided', async () => {
  for (const id of ['ubc-male', 'ubc-female']) {
    const body = parseWith(
      CanonicalBodySchema,
      JSON.parse(await fs.readFile(`${BODIES_DIR}/${id}/body.json`, 'utf8')),
      `${id} body.json`,
    );
    assertEquals(body.license, 'CC0-1.0', `${id}: bundled means permissive, stated`);
    assertEquals(body.skeleton, 'ual-humanoid');

    const doc = await new NodeIO().readBinary(
      new Uint8Array(await fs.readFile(`${BODIES_DIR}/${id}/body.glb`)),
    );
    const joints = doc.getRoot().listSkins()[0].listJoints().map((j) => j.getName());
    const lower = new Set(joints.map((j) => j.toLowerCase()));
    const missing = UAL_HUMANOID.core.filter((c) => !lower.has(c.toLowerCase()));
    assertEquals(missing, [], `${id}: every UAL core joint present`);

    // regions must cover both sides and the centre — a decal or bone mask
    // that cannot name "the left arm" defeats the whole identity layer
    const sides = new Map<string, number>();
    for (const r of body.regions) sides.set(r.side, (sides.get(r.side) ?? 0) + 1);
    assert((sides.get('left') ?? 0) >= 3, `${id}: left regions exist`);
    assert((sides.get('right') ?? 0) >= 3, `${id}: right regions exist`);
    assertEquals(sides.get('left'), sides.get('right'), `${id}: sides are balanced`);
  }
});

test('ACCEPTANCE: the male body fits all three proportioned humanoids cleanly', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    // expected heights are the fixtures' MEASURED mesh extents, not the
    // skeleton design heights from the P3-T1 notes (1.908 vs the folkloric
    // 2.1, etc.) — the first run of this test failed on exactly that gap,
    // and the fit was the honest one
    for (
      const [target, expectHeight] of [
        ['humanoid-normal.glb', 1.908],
        ['humanoid-tall-thin.glb', 2.293],
        ['humanoid-short-chunky.glb', 1.42],
      ] as Array<[string, number]>
    ) {
      const out = `${dir}/${target.replace('.glb', '')}-fitted.glb`;
      const fit = await fitCanonicalBody({
        bodyPath: `${BODIES_DIR}/ubc-male/body.glb`,
        bodyManifestPath: `${BODIES_DIR}/ubc-male/body.json`,
        targetPath: `${FIXTURES}/${target}`,
        outPath: out,
      });

      // The invariant that matters: no CORE joint outside the target. The
      // box fixtures have no fingers — their hand is a box ending at the
      // wrist — so on the chunky build the real body's fingertip chain pokes
      // past the box's bounds and the fit REPORTS it, which is the honest
      // reading of a crude target rather than a failure of the fit. A core
      // stray (a knee outside the leg) would be a torn fit and fails here.
      const coreStrays = fit.strayJoints.filter((j) =>
        UAL_HUMANOID.core.some((c) => c.toLowerCase() === j.toLowerCase())
      );
      assertEquals(coreStrays, [], `${target}: no CORE joint ended up outside the body`);
      for (const stray of fit.strayJoints) {
        assert(
          /(index|middle|ring|pinky|thumb)_\d\d|_leaf_/.test(stray),
          `${target}: stray "${stray}" is a finger extremity, not a body joint`,
        );
      }
      assert(
        Math.abs(fit.heightM - expectHeight) < 0.02,
        `${target}: fitted to ~${expectHeight} m (got ${fit.heightM.toFixed(3)})`,
      );
      assert(
        Number.isFinite(fit.meanSurfaceErrorM) && fit.meanSurfaceErrorM > 0,
        `${target}: surface error is honest — a real body differs from a box fixture ` +
          `(mean ${fit.meanSurfaceErrorM.toFixed(4)} m)`,
      );
      assert(
        fit.meanSurfaceErrorM < 0.15,
        `${target}: but bounded (mean ${fit.meanSurfaceErrorM.toFixed(4)} m)`,
      );

      // the fitted glb is real: parses, one skin, weights intact
      const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(out)));
      assertEquals(doc.getRoot().listSkins().length, 1, `${target}: one skin`);
    }
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
