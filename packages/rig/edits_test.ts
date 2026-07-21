/**
 * Tier-1 repairs: the nudge, the opt-in mirror, and the promise that an edit
 * survives a re-run as a hint. Pure data in, pure data out — no GPU, no glb
 * needed for most of it.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { JointEdit, RigSkeleton } from '@spritebook/schema';
import { applyJointEdits, hintsFromEdits, sidePartner } from './edits.ts';

function skeleton(names: string[]): RigSkeleton {
  return {
    schemaVersion: 1,
    backend: { modelId: 'unirig', version: 'test' },
    seed: 0,
    joints: names.map((name, i) => ({
      name,
      parent: i === 0 ? -1 : 0,
      head: [i * 0.1, 1, 0] as [number, number, number],
      tail: [i * 0.1, 1.1, 0] as [number, number, number],
    })),
    semanticNames: true,
    vertexCount: 100,
    influencesPerVertex: 4,
    validation: {
      nonFiniteWeights: 0,
      unnormalizedVertices: 0,
      zeroWeightVertices: 0,
      retries: 0,
    },
  };
}

Deno.test('sidePartner reads naming conventions, never geometry', () => {
  assertEquals(sidePartner('upperarm_l'), 'upperarm_r');
  assertEquals(sidePartner('upperarm_r'), 'upperarm_l');
  assertEquals(sidePartner('Hand.L'), 'Hand.R');
  assertEquals(sidePartner('LeftShoulder'), 'RightShoulder');
  assertEquals(sidePartner('spine_01'), null, 'a centre joint has no partner');
  assertEquals(sidePartner('bone_7'), null, 'generic names carry no side');
});

Deno.test('a nudge moves head AND tail, leaving other joints alone', () => {
  const s = skeleton(['root', 'upperarm_l', 'upperarm_r']);
  const r = applyJointEdits(s, [{ joint: 'upperarm_l', delta: [0.05, -0.02, 0], mirrored: false }]);
  assertEquals(r.moved, ['upperarm_l']);
  const l = r.skeleton.joints[1];
  const r6 = (v: number) => Number(v.toFixed(6));
  assertEquals([r6(l.head[0]), r6(l.head[1])], [0.15, 0.98]);
  assertEquals([r6(l.tail[0]), r6(l.tail[1])], [0.15, 1.08], 'tail follows the head');
  assertEquals(r6(r.skeleton.joints[2].head[0]), 0.2, 'the right arm did not move');
  // the input skeleton is untouched: callers decide what to persist
  assertEquals(s.joints[1].head[0], 0.1, 'applyJointEdits is pure');
});

Deno.test('mirroring is opt-in and negates X only (D-008)', () => {
  const s = skeleton(['root', 'upperarm_l', 'upperarm_r']);
  const off = applyJointEdits(s, [{ joint: 'upperarm_l', delta: [0.05, 0, 0], mirrored: false }]);
  assertEquals(off.moved, ['upperarm_l'], 'asymmetric by default');

  const on = applyJointEdits(s, [{ joint: 'upperarm_l', delta: [0.05, 0.01, 0], mirrored: true }]);
  assertEquals(on.moved, ['upperarm_l', 'upperarm_r']);
  const [, left, right] = on.skeleton.joints;
  assertEquals(Number(left.head[0].toFixed(6)), 0.15, 'left moved +X');
  assertEquals(Number(right.head[0].toFixed(6)), 0.15, 'right moved -X (mirrored)');
  assertEquals(left.head[1], right.head[1], 'Y is not mirrored');
});

Deno.test('unknown joints and missing partners are reported, never silent', () => {
  const s = skeleton(['root', 'upperarm_l']);
  const r = applyJointEdits(s, [
    { joint: 'nose', delta: [1, 0, 0], mirrored: false },
    { joint: 'upperarm_l', delta: [0.01, 0, 0], mirrored: true },
  ]);
  assertEquals(r.unknownJoints, ['nose'], 'a typo is surfaced, not ignored');
  assertEquals(r.missingPartners, ['upperarm_l'], 'a one-armed rig says so');
  assertEquals(r.moved, ['upperarm_l'], 'the valid edit still applied');
});

Deno.test('edits become ABSOLUTE hints for the next run', () => {
  const s = skeleton(['root', 'upperarm_l', 'upperarm_r']);
  const edits: JointEdit[] = [{ joint: 'upperarm_l', delta: [0.05, 0, 0], mirrored: true }];
  const edited = applyJointEdits(s, edits).skeleton;
  const hints = hintsFromEdits(edited, edits);
  // both the edited joint and its mirrored partner become markers
  assertEquals(hints.map((h) => h.joint), ['upperarm_l', 'upperarm_r']);
  assertEquals(
    Number(hints[0].position[0].toFixed(6)),
    0.15,
    'the hint is where it ENDED UP, not the delta',
  );
  assert(
    hints.every((h) => h.position.every(Number.isFinite)),
    'hints are finite absolute positions',
  );
});
