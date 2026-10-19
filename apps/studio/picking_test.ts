import { test } from 'node:test';
/**
 * The viewport's pure parts. The mirror rule is CROSS-CHECKED against core's
 * own `sidePartner` — the GUI only previews which joint will move (core does
 * the mirroring from the edit's flag), and a preview that disagreed with the
 * verb would be a lie told confidently.
 */
import { assert, assertEquals } from '@std/assert';
import { sidePartner } from '@spritebook/rig';
import {
  editsFile,
  mergeEdits,
  mirrorPartner,
  type PendingEdit,
  pickJoint,
  type ScreenJoint,
} from './src/viewport/picking.ts';

const J = (name: string, x: number, y: number, depth = 1): ScreenJoint => ({ name, x, y, depth });

test('picking takes the nearest joint inside the radius, or nothing', () => {
  const joints = [J('hips', 100, 100), J('spine_01', 140, 100), J('head', 300, 300)];
  assertEquals(pickJoint(joints, 102, 101, 14), 'hips');
  assertEquals(pickJoint(joints, 138, 103, 14), 'spine_01');
  // a miss must DESELECT rather than grab whatever was closest on screen
  assertEquals(pickJoint(joints, 200, 200, 14), null);
  assertEquals(pickJoint([], 0, 0, 14), null);
});

test('overlapping joints break the tie toward the nearer one', () => {
  // the elbow in front of the shoulder at the same screen pixel
  const stacked = [J('shoulder_l', 100, 100, 5.0), J('elbow_l', 100, 100, 2.0)];
  assertEquals(pickJoint(stacked, 100, 100, 14), 'elbow_l');
  assertEquals(pickJoint([...stacked].reverse(), 100, 100, 14), 'elbow_l', 'order-independent');
});

test('the mirror rule IS core’s rule, pattern for pattern', () => {
  const names = [
    'clavicle_l',
    'clavicle_r',
    'thumb_03_l',
    'pinky_01_R',
    'upperarm.L',
    'lowerarm.R',
    'LeftHand',
    'RightFoot',
    'spine_01',
    'Head',
    'root',
  ];
  for (const n of names) {
    assertEquals(
      mirrorPartner(n),
      sidePartner(n),
      `${n}: the preview must name the joint core will actually move`,
    );
  }
  // and a sideless joint has no partner in either
  assertEquals(mirrorPartner('spine_01'), null);
});

test('the edits file is exactly what `rig --edits` reads', () => {
  const edits: PendingEdit[] = [{ joint: 'clavicle_r', delta: [0.01, -0.02, 0], mirrored: true }];
  const doc = editsFile(edits);
  assertEquals(Object.keys(doc), ['edits'], 'no extra keys — the schema is strict');
  assertEquals(doc.edits[0]!.joint, 'clavicle_r');
  assertEquals(doc.edits[0]!.delta.length, 3);
  assertEquals(typeof doc.edits[0]!.mirrored, 'boolean');
  assert(doc.edits !== edits, 'the caller keeps its array');
});

test('repeated nudges of one joint SUM into a single edit', () => {
  let edits: PendingEdit[] = [];
  edits = mergeEdits(edits, { joint: 'clavicle_r', delta: [0.01, 0, 0], mirrored: false });
  edits = mergeEdits(edits, { joint: 'clavicle_r', delta: [0.02, 0.01, 0], mirrored: true });
  assertEquals(edits.length, 1, 'core must receive the sum, not a sequence');
  assertEquals(edits[0]!.delta, [0.03, 0.01, 0]);
  assertEquals(edits[0]!.mirrored, true, 'the latest intent wins');

  edits = mergeEdits(edits, { joint: 'thumb_03_l', delta: [0, 0.005, 0], mirrored: false });
  assertEquals(edits.length, 2, 'a different joint is a different edit');

  // dragged back to where it started is not an edit at all
  edits = mergeEdits(edits, { joint: 'clavicle_r', delta: [-0.03, -0.01, 0], mirrored: true });
  assertEquals(edits.map((e) => e.joint), ['thumb_03_l']);
});
