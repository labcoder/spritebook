import { test } from 'node:test';
/**
 * The Bake stage's arithmetic: reading
 * core's own progress events, an ETA that refuses to speak before it can, the
 * player's frame selection, and the flag→stage jump.
 */
import { assert, assertEquals } from '@std/assert';
import { etaSeconds, flagStage, readProgress, summarize } from './src/bakeprogress.ts';

test('readProgress takes core progress events and nothing else', () => {
  assertEquals(
    readProgress(
      JSON.stringify({ t: 'progress', jobId: 'bake', step: 'cells', done: 1, total: 4 }),
    ),
    { step: 'cells', done: 1, total: 4, fraction: 0.25 },
  );
  assertEquals(readProgress(JSON.stringify({ t: 'done', wallTimeS: 3 })), null);
  assertEquals(readProgress(JSON.stringify({ t: 'warn', code: 'x' })), null);
  assertEquals(readProgress('not json'), null);
  // a malformed total must not produce Infinity or NaN
  const odd = readProgress(JSON.stringify({ t: 'progress', step: 'x', done: 3, total: 0 }))!;
  assertEquals(odd.fraction, 1);
});

test('the ETA stays silent until it can be honest', () => {
  const p = (done: number, total = 4) => ({
    step: 's',
    done,
    total,
    fraction: done / total,
  });
  assertEquals(etaSeconds(10, null), null, 'no progress, no promise');
  assertEquals(etaSeconds(10, p(0)), null, 'not one step done yet');
  assertEquals(etaSeconds(0.5, p(1)), null, 'too early to extrapolate');
  assertEquals(etaSeconds(10, p(4)), null, 'finished is not an estimate');
  assertEquals(etaSeconds(10, p(1)), 30, 'a quarter done in 10s: ~30s left');
  assertEquals(etaSeconds(10, p(2)), 10);
});

test('summarize refuses garbage instead of half-rendering it', () => {
  for (const bad of [null, 42, 'x', {}, { frames: [] }]) assertEquals(summarize(bad), null);
});

test('a flag jumps to the stage that OWNS it, never a guess', () => {
  assertEquals(flagStage({ sourceStage: 'look' }), 'look');
  assertEquals(flagStage({ sourceStage: 'rig' }), 'rig');
  assertEquals(flagStage({}), 'bake', 'no source stated: stay put');
  assertEquals(flagStage({ sourceStage: 'nonsense' }), 'bake', 'unknown: stay put');
});
