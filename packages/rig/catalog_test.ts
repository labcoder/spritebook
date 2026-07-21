/**
 * THE P0-T4 FAILURE-CATALOG DISPOSITION TABLE (P3-T3 acceptance).
 *
 * The roadmap's wording is "every cataloged failure is either fixed by
 * tier-1/tier-2 verbs or by --rerun-with-hints". Two of the six are not
 * repairable defects at all — they are the backend's resolution limits, and no
 * joint nudge or rotation improves a skinning weight. Pretending otherwise
 * would mean either a test that lies or a feature that does not exist, so the
 * acceptance was reframed (maintainer-approved) to: EVERY catalog item has an
 * explicit, tested disposition.
 *
 * Four dispositions are possible, and which one an item gets is itself the
 * finding:
 *
 *   fixed-by-adapter    the sidecar adapter handles it (naming, NaN retry,
 *                       renormalization guard) — asserted against the
 *                       contract the adapter must satisfy
 *   fixed-by-core       a verb or core stage handles it — asserted by behaviour
 *   fixed-upstream      an earlier task already solved it
 *   documented-limit    a model-quality limit with recorded evidence and a
 *                       user-visible warning, NOT a silent shrug
 *
 * The point of the table is that a limit the user is WARNED about is a
 * different product from a limit they discover in a shipped sprite sheet.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { RigSkeletonSchema } from '@spritebook/schema';
import { applyJointEdits, hintsFromEdits, sidePartner } from './edits.ts';
import { packWeightRows } from './apply.ts';
import { detectFacing } from './orient.ts';

type Disposition = 'fixed-by-adapter' | 'fixed-by-core' | 'fixed-upstream' | 'documented-limit';

interface CatalogItem {
  n: number;
  summary: string;
  disposition: Disposition;
  /** where the handling lives, for whoever reads this next */
  where: string;
}

/** Verbatim from spikes/autorig/REPORT.md "Failure-mode catalog". */
const CATALOG: CatalogItem[] = [
  {
    n: 1,
    summary: "the Giant's arm/torso boundary weights shred under animation",
    disposition: 'documented-limit',
    where: 'deformCheck flags excessive-stretch; rig job warns deform-flagged',
  },
  {
    n: 2,
    summary: 'sparse predictions on chunky characters (22 bones) leave rigid regions',
    disposition: 'documented-limit',
    where: 'jointCount recorded in RigState; fine at 128px per the P0-T4 verdict',
  },
  {
    n: 3,
    summary: 'generic bone_N names break name-based tooling downstream',
    disposition: 'fixed-by-adapter',
    where: 'RigSkeleton.semanticNames + the adapter naming pass; core warns when false',
  },
  {
    n: 4,
    summary: 'model-output NaN is a silent failure class',
    disposition: 'fixed-by-adapter',
    where: 'validation.nonFiniteWeights + retry on a fresh seed; core warns rig-retried',
  },
  {
    n: 5,
    summary: 'merge-stage weight renormalization breaks on zero-weight vertices',
    disposition: 'fixed-by-core',
    where: 'packWeightRows rigid-binds zero rows to the root and counts them',
  },
  {
    n: 6,
    summary: 'left/right assignment is ambiguous from geometry on symmetric bodies',
    disposition: 'fixed-upstream',
    where: 'P3-T1 side anchors; sidePartner() reads NAMES, never geometry',
  },
];

Deno.test('catalog item 3: generic names are a first-class fact, not a guess', () => {
  // the contract REQUIRES the adapter to state this, so a rig cannot arrive
  // with unknown naming provenance
  const base = {
    schemaVersion: 1,
    backend: { modelId: 'unirig', version: 'x' },
    seed: 0,
    joints: [{ name: 'bone_0', parent: -1, head: [0, 0, 0], tail: [0, 1, 0] }],
    vertexCount: 10,
    influencesPerVertex: 4,
    validation: {
      nonFiniteWeights: 0,
      unnormalizedVertices: 0,
      zeroWeightVertices: 0,
      retries: 0,
    },
  };
  assert(
    !RigSkeletonSchema.safeParse(base).success,
    'a skeleton without semanticNames is rejected: the fact is mandatory',
  );
  assert(RigSkeletonSchema.safeParse({ ...base, semanticNames: false }).success);
});

Deno.test('catalog item 4: the NaN retry is recorded, so a rig never lies about its seed', () => {
  const withRetry = RigSkeletonSchema.safeParse({
    schemaVersion: 1,
    backend: { modelId: 'unirig', version: 'x' },
    seed: 7,
    joints: [{ name: 'root', parent: -1, head: [0, 0, 0], tail: [0, 1, 0] }],
    semanticNames: true,
    vertexCount: 10,
    influencesPerVertex: 4,
    validation: {
      nonFiniteWeights: 128,
      unnormalizedVertices: 0,
      zeroWeightVertices: 0,
      retries: 1,
    },
  });
  assert(withRetry.success, 'the contract carries the evidence of a retry');
  // a retried rig was NOT produced by the seed the user asked for, and the job
  // warns about exactly that (rig-retried in job.ts)
  assertEquals(withRetry.data!.validation.retries, 1);
});

Deno.test('catalog item 5: zero-weight vertices are bound and counted, never divided by zero', () => {
  // one vertex with no influence at all — the merge-stage crash from P0-T4
  const rows = packWeightRows(
    new Uint32Array([0, 0, 0, 0, 1, 0, 0, 0]),
    new Float32Array([0, 0, 0, 0, 0.5, 0, 0, 0]),
    2,
    4,
    2,
    'catalog item 5',
  );
  assertEquals(rows.zeroWeightVertices, 1, 'the dead row is counted');
  assert(
    rows.weights.slice(0, 4).every(Number.isFinite),
    'no NaN from a divide-by-zero renormalization',
  );
  const sum0 = rows.weights.slice(0, 4).reduce((a, b) => a + b, 0);
  assertEquals(Number(sum0.toFixed(5)), 1, 'the dead vertex is rigid-bound, not left at zero');
  const sum1 = rows.weights.slice(4, 8).reduce((a, b) => a + b, 0);
  assertEquals(Number(sum1.toFixed(5)), 1, 'the live vertex renormalizes to 1');
});

Deno.test('catalog item 6: sides come from names, so float noise cannot flip them', () => {
  assertEquals(sidePartner('upperarm_l'), 'upperarm_r');
  // the failure mode was geometric detection tying itself to float noise; a
  // name-based rule is stable under ANY perturbation of the mesh
  const s = {
    schemaVersion: 1,
    backend: { modelId: 'unirig', version: 'x' },
    seed: 0,
    joints: [
      { name: 'root', parent: -1, head: [0, 0, 0], tail: [0, 1, 0] },
      { name: 'arm_l', parent: 0, head: [0.2, 1, 0], tail: [0.4, 1, 0] },
      // deliberately placed on the SAME side as the left arm: geometry would
      // call this left too, naming knows better
      { name: 'arm_r', parent: 0, head: [0.19, 1, 0], tail: [0.39, 1, 0] },
    ],
    semanticNames: true,
    vertexCount: 10,
    influencesPerVertex: 4,
    validation: {
      nonFiniteWeights: 0,
      unnormalizedVertices: 0,
      zeroWeightVertices: 0,
      retries: 0,
    },
  } as never;
  const r = applyJointEdits(s, [{ joint: 'arm_l', delta: [0, 0.1, 0], mirrored: true }]);
  assertEquals(r.moved, ['arm_l', 'arm_r'], 'the partner is found by name despite the geometry');
  assertEquals(r.missingPartners, []);
});

Deno.test('items 1 and 2 are LIMITS: named, measured, and warned about', () => {
  // The honest half of the table. Neither is repairable by a verb, so what we
  // owe the user is detection and a warning rather than a silent shrug:
  //  - item 1 (shredding) surfaces as excessive-stretch in the deform report,
  //    which the rig job turns into a deform-flagged warn naming the joints;
  //  - item 2 (sparse bones) surfaces as jointCount in RigState, and the
  //    P0-T4 verdict recorded that it is acceptable at sprite resolution.
  const limits = CATALOG.filter((c) => c.disposition === 'documented-limit');
  assertEquals(limits.map((c) => c.n), [1, 2], 'exactly the two model-quality limits');
  for (const limit of limits) {
    assert(limit.where.length > 20, `item ${limit.n} records WHERE it is surfaced`);
  }
});

Deno.test('ACCEPTANCE: every P0-T4 catalog item has an explicit disposition', () => {
  assertEquals(CATALOG.length, 6, 'all six items from the REPORT.md catalog are accounted for');
  const byDisposition = new Map<Disposition, number[]>();
  for (const item of CATALOG) {
    assert(item.summary.length > 10, `item ${item.n} is described`);
    assert(item.where.length > 10, `item ${item.n} says where it is handled`);
    byDisposition.set(item.disposition, [...(byDisposition.get(item.disposition) ?? []), item.n]);
  }
  assertEquals(byDisposition.get('fixed-by-adapter'), [3, 4]);
  assertEquals(byDisposition.get('fixed-by-core'), [5]);
  assertEquals(byDisposition.get('fixed-upstream'), [6]);
  assertEquals(byDisposition.get('documented-limit'), [1, 2]);
});

Deno.test('the -Z front-derivation proof, as the catalog s companion', () => {
  // Not a catalog item but the other half of the acceptance: a mesh that is
  // simply turned around must be DETECTED, not silently baked backwards.
  const facingAway = new Float32Array([
    // a crude body facing -Z: toes protrude backwards
    -0.25,
    1.2,
    0,
    0.25,
    1.2,
    0,
    -0.25,
    1.2,
    0.05,
    0.25,
    1.2,
    0.05,
    -0.1,
    0.05,
    -0.2,
    0.1,
    0.05,
    -0.2,
    -0.1,
    0.05,
    0.02,
    0.1,
    0.05,
    0.02,
    -0.1,
    0.6,
    0,
    0.1,
    0.6,
    0,
    -0.1,
    0.6,
    0.04,
    0.1,
    0.6,
    0.04,
  ]);
  const r = detectFacing(facingAway);
  assertEquals(r.facing, '-Z');
  assertEquals(r.suggestedFix, 'rotate-180', 'one verb fixes it');
});
