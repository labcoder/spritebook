/**
 * The Bake stage's arithmetic, pinned against the REAL p3-exit bake: reading
 * core's own progress events, an ETA that refuses to speak before it can, the
 * player's frame selection, and the flag→stage jump.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { etaSeconds, flagStage, playFrames, readProgress, summarize } from './src/bakeprogress.ts';

Deno.test('readProgress takes core progress events and nothing else', () => {
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

Deno.test('the ETA stays silent until it can be honest', () => {
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

Deno.test('the real p3-exit bake summarizes into what the player needs', async () => {
  let raw: string;
  try {
    raw = await Deno.readTextFile(
      new URL(
        '../../spikes/trellis2/out/p3-exit/bulma-fixed/bakes/bake-704614bc/manifest.json',
        import.meta.url,
      ),
    );
  } catch {
    console.log('skip: exit workspace not present on this machine');
    return;
  }
  const s = summarize(JSON.parse(raw))!;
  assertEquals(s.bakeId, '704614bc');
  assertEquals(s.frames.length, 48);
  assertEquals(s.clips, ['idle']);
  assertEquals(s.directions, [0, 1, 2, 3, 4, 5, 6, 7], 'eight directions, in order');
  assertEquals(s.passes, ['lit', 'albedo', 'normal', 'depth', 'mask'], 'every AOV page is offered');
  assertEquals(s.cacheHitPct, 0);
  assert(s.flickerPct > 0 && s.flickerPct < 1, `the real flicker rides along (${s.flickerPct})`);

  // 48 frames / 8 directions = 6 per direction, in frame order
  const strip = playFrames(s, 'idle', 3);
  assertEquals(strip.length, 6);
  assertEquals(strip.map((f) => f.frame), [0, 1, 2, 3, 4, 5]);
  assert(strip.every((f) => f.atlas.w > 0), 'each frame carries its atlas rect');
});

Deno.test('summarize refuses garbage instead of half-rendering it', () => {
  for (const bad of [null, 42, 'x', {}, { frames: [] }]) assertEquals(summarize(bad), null);
});

Deno.test('a flag jumps to the stage that OWNS it, never a guess', () => {
  assertEquals(flagStage({ sourceStage: 'look' }), 'look');
  assertEquals(flagStage({ sourceStage: 'rig' }), 'rig');
  assertEquals(flagStage({}), 'bake', 'no source stated: stay put');
  assertEquals(flagStage({ sourceStage: 'nonsense' }), 'bake', 'unknown: stay put');
});
