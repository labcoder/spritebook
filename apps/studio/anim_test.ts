import { test } from 'node:test';
/**
 * The Anim stage's two pure pieces: the binding spec builder speaks the
 * bake/enable grammar exactly (round-trips through core's parser shape), and
 * the frames math is the design doc's own arithmetic.
 */
import { assert, assertEquals } from '@std/assert';
import { bindingSpec, framesMath } from './src/bindings.ts';

test('bindingSpec speaks clip:frames[@speed][!hold] exactly', () => {
  assertEquals(
    bindingSpec({ clipId: 'idle-loop', frames: 6, speed: 1, holdLast: false }),
    'idle-loop:6',
  );
  assertEquals(
    bindingSpec({
      clipId: 'walk-loop',
      frames: 8,
      speed: 1.5,
      holdLast: false,
    }),
    'walk-loop:8@1.5',
  );
  assertEquals(
    bindingSpec({ clipId: 'death', frames: 10, speed: 1, holdLast: true }),
    'death:10!hold',
  );
  assertEquals(
    bindingSpec({ clipId: 'x', frames: 4, speed: 2, holdLast: true }),
    'x:4@2!hold',
  );
  // the grammar core parses: /^([a-z0-9][a-z0-9-]*):(\d+)(?:@([\d.]+))?(!hold)?$/
  const re = /^([a-z0-9][a-z0-9-]*):(\d+)(?:@([\d.]+))?(!hold)?$/;
  for (
    const b of [
      { clipId: 'idle-loop', frames: 6, speed: 1, holdLast: false },
      { clipId: 'walk-loop', frames: 8, speed: 1.5, holdLast: true },
    ]
  ) {
    assert(re.test(bindingSpec(b)), `core parses ${bindingSpec(b)}`);
  }
});

test('the frames math is the design doc arithmetic (3 clips x 8 dir x O7 = 168)', () => {
  const m = framesMath([
    { clipId: 'a', enabled: true, frames: 6, speed: 1, holdLast: false },
    { clipId: 'b', enabled: true, frames: 8, speed: 1, holdLast: false },
    { clipId: 'c', enabled: true, frames: 7, speed: 1, holdLast: false },
    { clipId: 'd', enabled: false, frames: 99, speed: 1, holdLast: false },
  ], 8);
  assertEquals(m.clips, 3, 'disabled clips are not counted');
  assertEquals(m.meanFrames, 7);
  assertEquals(m.total, 168, 'the doc example, literally');
  assertEquals(framesMath([], 8).total, 0);
});
