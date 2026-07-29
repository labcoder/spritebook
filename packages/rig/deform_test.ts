/**
 * The deform check is a measurement, so the fixture is built so the right
 * answers are known in advance: three joints own one rigid band of rings each
 * (so their edges cannot stretch), `bone_3` owns nothing, and `bone_4` owns
 * only the vertex sitting on its own pivot — a joint that influences geometry
 * and still cannot move it. Then one vertex is re-weighted onto a distant,
 * unmoving joint and the same rig has to report a torn band.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1';
import { DeformReportSchema } from '@spritebook/schema';
import {
  chainSkeleton,
  SHREDDED_VERTEX,
  shreddedWeights,
  stageCase,
  weightsNpz,
} from './_fixtures.ts';
import { applyRig } from './apply.ts';
import {
  DEFORM_REPORT_FILE,
  deformCheck,
  dominantPerpendicularAxis,
  uniqueEdges,
} from './deform.ts';
import type { DeformJointStat, DeformReport } from '@spritebook/schema';

function stat(report: DeformReport, joint: string): DeformJointStat {
  const s = report.joints.find((j) => j.joint === joint);
  assert(s, `no stat for ${joint}`);
  return s;
}

Deno.test('deformCheck measures a working joint and writes its report', async () => {
  const c = await stageCase();
  try {
    await applyRig(c);
    const report = await deformCheck({
      riggedPath: c.outPath,
      outDir: c.dir,
      now: () => '2026-07-20T00:00:00.000Z',
    });

    assertEquals(report.poses, ['bend+30deg', 'bend-30deg']);
    assertEquals(report.joints.length, 5);
    assertEquals(report.at, '2026-07-20T00:00:00.000Z');

    const middle = stat(report, 'bone_1');
    assertEquals(middle.influencedVertices, 12); // three rings of four
    assert(middle.meanDisplacementM > 0, `mean displacement ${middle.meanDisplacementM}`);
    assert(middle.maxDisplacementM >= middle.meanDisplacementM);
    // a rigidly-skinned band cannot stretch: every edge ratio is exactly 1
    assertAlmostEquals(middle.maxEdgeStretch, 1, 1e-4);
    assertEquals(middle.flags, []);

    // the report on disk is the same document, and it validates
    const onDisk = JSON.parse(await Deno.readTextFile(`${c.dir}/${DEFORM_REPORT_FILE}`));
    DeformReportSchema.parse(onDisk);
    assertEquals(onDisk, report);
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('deformCheck flags a joint with no weights and a joint that cannot move', async () => {
  const c = await stageCase();
  try {
    await applyRig(c);
    const report = await deformCheck({ riggedPath: c.outPath, outDir: c.dir });

    const empty = stat(report, 'bone_3');
    assertEquals(empty.influencedVertices, 0);
    assertEquals(empty.flags, ['no-influence']);
    assertEquals(empty.meanDisplacementM, 0);

    // bone_4's only vertex sits exactly on its pivot, so bending it changes
    // nothing — influence without effect is the dead-joint case
    const pinned = stat(report, 'bone_4');
    assertEquals(pinned.influencedVertices, 1);
    assert(pinned.maxDisplacementM < 1e-5, `max displacement ${pinned.maxDisplacementM}`);
    assertEquals(pinned.flags, ['dead-joint']);

    assertEquals(report.flaggedJoints, ['bone_3', 'bone_4']);
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('deformCheck reports excessive stretch for a torn weight map', async () => {
  const good = await stageCase();
  const bad = await stageCase(chainSkeleton(), await weightsNpz(shreddedWeights()));
  try {
    await applyRig(good);
    await applyRig(bad);
    const clean = await deformCheck({ riggedPath: good.outPath, outDir: good.dir, angleDeg: 60 });
    const torn = await deformCheck({ riggedPath: bad.outPath, outDir: bad.dir, angleDeg: 60 });

    // same mesh, same skeleton, same pose set: only the weights differ
    assertAlmostEquals(stat(clean, 'bone_1').maxEdgeStretch, 1, 1e-4);
    assert(!clean.flaggedJoints.includes('bone_1'));

    const shredded = stat(torn, 'bone_1');
    assertEquals(shredded.influencedVertices, 12); // the sliver still clears the floor
    assert(shredded.maxEdgeStretch > 2, `max edge stretch ${shredded.maxEdgeStretch}`);
    assertEquals(shredded.flags, ['excessive-stretch']);
    assert(torn.flaggedJoints.includes('bone_1'));
  } finally {
    await Deno.remove(good.dir, { recursive: true });
    await Deno.remove(bad.dir, { recursive: true });
  }
});

Deno.test('deformCheck honours the weight floor', async () => {
  const c = await stageCase(chainSkeleton(), await weightsNpz(shreddedWeights()));
  try {
    await applyRig(c);
    // above the sliver weight, the torn vertex is no longer bone_1's problem
    const report = await deformCheck({
      riggedPath: c.outPath,
      outDir: c.dir,
      angleDeg: 60,
      weightFloor: 0.5,
    });
    const middle = stat(report, 'bone_1');
    assertEquals(middle.influencedVertices, 11);
    assertAlmostEquals(middle.maxEdgeStretch, 1, 1e-4);
    assertEquals(middle.flags, []);
    // and it moved to bone_0's set, where the whole subtree turns rigidly
    assertEquals(stat(report, 'bone_0').influencedVertices, 13);
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('deformCheck rejects nonsense pose parameters', async () => {
  const c = await stageCase();
  try {
    await applyRig(c);
    for (
      const [opts, needle] of [
        [{ angleDeg: 0 }, 'angleDeg must be positive'],
        [{ weightFloor: 1 }, 'weightFloor must be in [0, 1)'],
      ] as const
    ) {
      let message = '';
      try {
        await deformCheck({ riggedPath: c.outPath, outDir: c.dir, ...opts });
      } catch (err) {
        message = (err as Error).message;
      }
      assert(message.includes(needle), `expected "${needle}", got: ${message}`);
    }
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('dominantPerpendicularAxis picks the most perpendicular world axis', () => {
  // a vertical bone: X and Z are both perpendicular, the tie breaks to X
  assertEquals([...dominantPerpendicularAxis([0, 1, 0])], [1, 0, 0]);
  // a bone along X: Y wins the tie against Z
  assertEquals([...dominantPerpendicularAxis([1, 0, 0])], [0, 1, 0]);
  assertEquals([...dominantPerpendicularAxis([0, 0, 1])], [1, 0, 0]);

  // a slanted bone: the axis it leans on least, orthogonalized to exactly 90
  const d: [number, number, number] = [0.6, 0.8, 0];
  const a = dominantPerpendicularAxis(d);
  assertAlmostEquals(a[0] * d[0] + a[1] * d[1] + a[2] * d[2], 0, 1e-6);
  assertAlmostEquals(Math.hypot(a[0], a[1], a[2]), 1, 1e-6);
  assertEquals(a[2], 1); // Z is untouched by a bone in the XY plane
});

Deno.test('uniqueEdges deduplicates the shared edges of a quad', () => {
  const edges = uniqueEdges(Uint32Array.from([0, 1, 2, 0, 2, 3]), 4);
  const pairs = new Set<string>();
  for (let i = 0; i < edges.length; i += 2) pairs.add(`${edges[i]}-${edges[i + 1]}`);
  assertEquals(pairs.size, 5); // four sides plus the shared diagonal, counted once
  assert(pairs.has('0-2'));
});

Deno.test('the torn vertex is the one the fixture aimed at', async () => {
  const c = await stageCase(chainSkeleton(), await weightsNpz(shreddedWeights()));
  try {
    const result = await applyRig(c);
    assertEquals(result.renormalizedVertices, 0); // 0.06 + 0.94 sums to 1 already
    assertEquals(SHREDDED_VERTEX, 20);
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('a huge max on scattered edges no longer convicts a joint', async () => {
  // The bulma finding in miniature (spikes/trellis2/deform_dist.py): calf_l
  // carried maxEdgeStretch 3.76 from 5 outlier edges of 21,909 (0.02%, P99
  // 1.24) and was flagged identically to spine_02's genuine 712-edge band.
  // The flag is now the seam rule - stretchedEdges >= max(2, fraction of
  // influencedEdges) - so the SAME torn data stops flagging when the fraction
  // is set above its seam size, while the max still reports the severity.
  const c = await stageCase(chainSkeleton(), await weightsNpz(shreddedWeights()));
  try {
    await applyRig(c);
    const report = await deformCheck({
      riggedPath: c.outPath,
      outDir: c.dir,
      angleDeg: 60,
      stretchFraction: 0.9, // the toy's tear is a few edges, far below 90%
    });
    const s = stat(report, 'bone_1');
    assert(s.maxEdgeStretch > 2, `the outlier is still measured: ${s.maxEdgeStretch}`);
    assert(s.stretchedEdges >= 2, `and counted: ${s.stretchedEdges}`);
    assert(s.stretchedEdges < s.influencedEdges * 0.9, 'but it is not a seam at this fraction');
    assertEquals(s.flags, [], 'so the max alone no longer convicts');
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('the seam rule needs two edges - one outlier is never a tear', async () => {
  // MIN_STRETCHED_EDGES exists so a single wild edge cannot flag a joint no
  // matter how small the influenced set is. The torn fixture tears several
  // incident edges, so it clears the floor; this pins the floor itself.
  const c = await stageCase(chainSkeleton(), await weightsNpz(shreddedWeights()));
  try {
    await applyRig(c);
    const report = await deformCheck({ riggedPath: c.outPath, outDir: c.dir, angleDeg: 60 });
    const s = stat(report, 'bone_1');
    // the fixture's tear IS a multi-edge seam: that is why it may flag at all
    assert(s.stretchedEdges >= 2, `fixture tears a seam, got ${s.stretchedEdges} edges`);
    assertEquals(s.flags, ['excessive-stretch']);
    // the report carries the denominator, so a reader can judge the fraction
    assert(s.influencedEdges > 0);
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});

Deno.test('auto-hints: a torn joint far from its flesh gets an edit; a floor filters', async () => {
  const { deriveAutoHints } = await import('./autohints.ts');
  const c = await stageCase(chainSkeleton(), await weightsNpz(shreddedWeights()));
  try {
    await applyRig(c);
    const report = await deformCheck({ riggedPath: c.outPath, outDir: c.dir, angleDeg: 60 });
    assert(report.flaggedJoints.includes('bone_1'), 'precondition: the fixture tears');

    // floor 0: every measurable torn joint yields an edit toward its centroid
    const open = await deriveAutoHints(c.outPath, report, chainSkeleton(), { minOffsetM: 0 });
    const edit = open.edits.find((e) => e.joint === 'bone_1');
    assert(edit, `bone_1 edit expected, got ${JSON.stringify(open)}`);
    assert(Math.hypot(...edit.delta) > 0, 'the delta moves the joint');
    assertEquals(open.belowFloor.length, 0);

    // a huge floor reclassifies the same joint as "nothing to exploit", WITH
    // its measured offset, so the caller can say so in millimetres
    const closed = await deriveAutoHints(c.outPath, report, chainSkeleton(), { minOffsetM: 10 });
    assert(!closed.edits.some((e) => e.joint === 'bone_1'));
    const below = closed.belowFloor.find((b) => b.joint === 'bone_1');
    assert(below, 'bone_1 lands below the floor');
    assertEquals(below.offsetM, Math.hypot(...edit.delta), 'same measurement, either side');
  } finally {
    await Deno.remove(c.dir, { recursive: true });
  }
});
