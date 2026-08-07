/**
 * The Rig stage's projections, pinned against the REAL bulma-fixed deform
 * report: the table is the report verbatim (flags, magnitudes), worst tear
 * first, clean joints counted not hidden — and the arg builder produces
 * exactly the exit script's own invocation shapes.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { projectReport, rigRunArgs } from './src/rig.ts';

// SNAPSHOT of the real exit workspace's report (fixtures/), taken 2026-08-07
// after the maintainer's UX-pass re-rig - the live dir is a playground now.
Deno.test('the real p3-exit report projects verbatim, worst tear first', async () => {
  const raw = await Deno.readTextFile(
    new URL('./fixtures/p3-exit-deform-report.json', import.meta.url),
  );
  const v = projectReport(JSON.parse(raw))!;
  assertEquals(v.totalJoints, 52);
  assertEquals(
    v.flagged.length,
    14,
    'what the UX-pass re-rig flagged, verbatim',
  );
  assertEquals(
    v.flagged.length + v.cleanCount,
    v.totalJoints,
    'nothing hidden',
  );
  assertEquals(v.poses, ['bend+30deg', 'bend-30deg']);
  // worst first: every row's stretch >= the next row's
  for (let i = 1; i < v.flagged.length; i++) {
    assert(v.flagged[i - 1]!.maxEdgeStretch >= v.flagged[i]!.maxEdgeStretch);
  }
  const clav = v.flagged.find((j) => j.joint === 'clavicle_r');
  assert(
    clav && clav.maxEdgeStretch > 7,
    'the known worst joint leads with its real number',
  );
  assertEquals(v.flagged[0]!.joint, 'clavicle_r', 'and it sorts first');
});

Deno.test('garbage reports project to null, never a crash', () => {
  for (const bad of [null, 42, 'x', {}, { joints: 'nope' }]) {
    assertEquals(projectReport(bad), null);
  }
});

Deno.test('the arg builder speaks the exit script dialect exactly', () => {
  assertEquals(rigRunArgs('W', {}), [
    'rig',
    '--model',
    'W/canonical/model.glb',
    '--out',
    'W/rig',
    '--workspace',
    'W',
  ]);
  assertEquals(
    rigRunArgs('W', { fixes: ['face-front'] }).slice(-1),
    ['--face-front'],
  );
  assertEquals(
    rigRunArgs('W', { fixes: ['rotate-180'] }).slice(-2),
    ['--rotate', '180'],
  );
  assertEquals(
    rigRunArgs('W', { trackA: true, bodyDir: 'B' }).slice(-3),
    ['--track-a', '--body', 'B'],
  );
  assertEquals(rigRunArgs('W', { autoHints: true }).slice(-1), [
    '--auto-hints',
  ]);
  assertEquals(
    rigRunArgs('W', { editsPath: 'p.json', rerunWithHints: true }).slice(-3),
    ['--edits', 'p.json', '--rerun-with-hints'],
  );
});
