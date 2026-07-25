/**
 * runFitJob wraps fit.ts in the JobEvent contract, so these tests are about
 * DISCIPLINE rather than geometry (fit_test.ts owns the numbers):
 *
 * - the stream is schema-valid, ends in `done`, and its artifacts exist;
 * - a torn fit WARNS (fit-stray-joints) and still finishes — the maintainer's
 *   rule is warn-don't-fail, and this is the test that keeps it true;
 * - with a workspace the fit lands as ONE journaled Track A RigState patch;
 * - a missing or invalid body dir is an actionable error naming the file.
 *
 * The body is the REAL bundled ubc-male (65 UAL joints, CC0, committed at
 * bodies/ubc-male) fitted to the P3-T1 proportioned box humanoid — real data,
 * CPU-only, fast.
 */
import { assert, assertEquals, assertGreater } from 'jsr:@std/assert@1';
import type { CharacterId, JobEvent } from '@spritebook/schema';
import { CharacterManifestSchema, JobEventSchema, parseWith } from '@spritebook/schema';
import { createWorkspace, workspacePaths } from '@spritebook/core';
import { BODY, buildTargetGlb, CHUNKY } from './_fit_fixtures.ts';
import { runFitJob } from './fitjob.ts';

/** The bundled 65-joint UAL body (packages/rig/bodies/ubc-male). */
const UBC_MALE = decodeURIComponent(
  new URL('./bodies/ubc-male', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
);

/** Drain the stream, proving every event honours the NDJSON contract. */
async function collect(it: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const out: JobEvent[] = [];
  for await (const e of it) out.push(parseWith(JobEventSchema, e, 'JobEvent'));
  return out;
}

function artifact(events: JobEvent[], kind: string): string {
  const e = events.find((x) => x.t === 'artifact' && x.kind === kind);
  assert(e, `expected a ${kind} artifact; got ${JSON.stringify(events.at(-1))}`);
  return (e as { path: string }).path;
}

Deno.test('runFitJob: the real ubc-male onto the fixture humanoid ends done', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'sb-fitjob-' });
  try {
    const targetPath = `${dir}/target.glb`;
    await Deno.writeFile(targetPath, await buildTargetGlb(BODY));
    const events = await collect(runFitJob({
      jobId: 'fit-happy',
      bodyDir: UBC_MALE,
      targetPath,
      outDir: `${dir}/out`,
    }));

    assertEquals(events.filter((e) => e.t === 'error'), [], 'no error events');
    assertEquals(events[0].t, 'queued');
    assertEquals(events[1].t, 'started');
    assertEquals(events.at(-1)?.t, 'done', 'done is the terminal event');
    assertEquals(
      events.filter((e) => e.t === 'progress').map((e) => (e as { step: string }).step),
      ['fit', 'validate'],
    );

    const fitted = artifact(events, 'fit-model');
    assertEquals(fitted, `${dir}/out/fitted.glb`);
    assertGreater((await Deno.stat(fitted)).size, 0, 'fitted.glb exists');

    const report = JSON.parse(await Deno.readTextFile(artifact(events, 'fit-report')));
    assertEquals(report.bodyId, 'ubc-male', 'the report is bound to the body that produced it');
    assert(Number.isFinite(report.meanSurfaceErrorM), 'the report parses with its numbers');
    assert(Number.isInteger(report.unprojectedVertices), 'the additive count rides along');
    assert(Array.isArray(report.strayJoints));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('runFitJob: a torn fit WARNS with the joints named - NEVER an error', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'sb-fitjob-' });
  try {
    const targetPath = `${dir}/target.glb`;
    // CHUNKY's box hands give the 65-joint body's fingers nowhere to land
    await Deno.writeFile(targetPath, await buildTargetGlb(CHUNKY));
    const events = await collect(runFitJob({
      jobId: 'fit-torn',
      bodyDir: UBC_MALE,
      targetPath,
      outDir: `${dir}/out`,
    }));

    const report = JSON.parse(await Deno.readTextFile(artifact(events, 'fit-report')));
    assertGreater(report.strayJoints.length, 0, 'this fixture is supposed to tear');

    const warn = events.find((e) => e.t === 'warn' && e.code === 'fit-stray-joints');
    assert(
      warn,
      `expected a fit-stray-joints warn in ${JSON.stringify(events.filter((e) => e.t === 'warn'))}`,
    );
    const message = (warn as { message: string }).message;
    assert(message.includes(report.strayJoints[0]), `the warn NAMES the joints: ${message}`);

    // the maintainer's rule, asserted in both directions
    assertEquals(events.filter((e) => e.t === 'error'), [], 'a tear is a warn, never an error');
    assertEquals(events.at(-1)?.t, 'done', 'done is still the terminal event');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('runFitJob: with a workspace, the fit is ONE journaled Track A patch', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'sb-fitjob-' });
  try {
    const ws = `${dir}/character`;
    await createWorkspace({
      workspace: ws,
      characterId: 'hero' as CharacterId,
      displayName: 'hero',
      source: { kind: 'image', originalFilename: 'hero.png', sha256: 'a'.repeat(64) },
    });
    const targetPath = `${dir}/target.glb`;
    await Deno.writeFile(targetPath, await buildTargetGlb(BODY));
    const events = await collect(runFitJob({
      jobId: 'fit-ws',
      bodyDir: UBC_MALE,
      targetPath,
      outDir: `${dir}/out`,
      workspace: ws,
    }));
    assertEquals(events.at(-1)?.t, 'done');
    assert(
      !events.some((e) => e.t === 'warn' && e.code === 'fit-not-recorded'),
      'recording succeeded',
    );

    const manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await Deno.readTextFile(artifact(events, 'character-manifest'))),
      'CharacterManifest',
    );
    const bodyJson = JSON.parse(await Deno.readTextFile(`${UBC_MALE}/body.json`));
    assertEquals(manifest.rig?.track, 'A');
    assertEquals(manifest.rig?.skeletonProfile, 'ual-humanoid');
    assertEquals(manifest.rig?.jointCount, bodyJson.jointCount, "the BODY's joint count (65)");
    assertEquals(
      manifest.rig?.backend,
      undefined,
      'no backend field: the fit is deterministic core code, not an AI model',
    );
    assertEquals(manifest.rig?.jointEdits, []);
    assertEquals(manifest.rig?.orientationFixes, []);
    assertEquals(manifest.rig?.accepted, false, "acceptance is the user's to set");

    // the journal grew by exactly ONE patch, and it carries its inverse
    const lines = (await Deno.readTextFile(workspacePaths(ws).journal))
      .split('\n')
      .filter((l) => l);
    assertEquals(lines.length, 1, 'one mutation, one patch');
    const patch = JSON.parse(lines[0]);
    assert(Array.isArray(patch.inverse) && patch.inverse.length > 0, 'undo can take the fit back');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('runFitJob: a missing or invalid body dir is an error naming the file', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'sb-fitjob-' });
  try {
    const targetPath = `${dir}/target.glb`;
    await Deno.writeFile(targetPath, await buildTargetGlb(BODY));

    // missing entirely
    const missing = await collect(runFitJob({
      jobId: 'fit-nobody',
      bodyDir: `${dir}/no-such-body`,
      targetPath,
      outDir: `${dir}/out`,
    }));
    const err = missing.at(-1);
    assert(err?.t === 'error', `expected a terminal error, got ${JSON.stringify(err)}`);
    if (err.t === 'error') {
      assertEquals(err.code, 'fit-body-invalid');
      assert(
        err.message.includes(`${dir}/no-such-body/body.json`),
        `names the path: ${err.message}`,
      );
    }

    // present but not a canonical body manifest
    const bodyDir = `${dir}/bad-body`;
    await Deno.mkdir(bodyDir, { recursive: true });
    await Deno.writeTextFile(`${bodyDir}/body.json`, '{"schemaVersion": 2}');
    const invalid = await collect(runFitJob({
      jobId: 'fit-badbody',
      bodyDir,
      targetPath,
      outDir: `${dir}/out2`,
    }));
    const bad = invalid.at(-1);
    assert(bad?.t === 'error', `expected a terminal error, got ${JSON.stringify(bad)}`);
    if (bad.t === 'error') {
      assertEquals(bad.code, 'fit-body-invalid');
      assert(bad.message.includes(`${bodyDir}/body.json`), `names the file: ${bad.message}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
