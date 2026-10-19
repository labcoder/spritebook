import { test } from 'node:test';
/**
 * The committed bundled UAL pack is loadable and searchable through the public
 * surface — this doubles as the `--list --tag` acceptance groundwork and as a
 * guard that the committed pack.json + clips stay mutually consistent.
 */
import { assert, assertEquals } from '@std/assert';
import { listClips, loadPack } from './dist/mod.js';

const UAL_DIR = new URL('./packs/ual', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('bundled UAL pack: loads, validates, and is searchable', async () => {
  const pack = await loadPack(UAL_DIR);
  assertEquals(pack.id, 'ual');
  assertEquals(pack.license, 'CC0-1.0');
  assertEquals(pack.redistributable, true);
  assertEquals(pack.skeleton, 'ual-humanoid');
  assertEquals(pack.clips.length, 86);

  const locomotion = listClips(pack, { category: 'locomotion' });
  assert(locomotion.length >= 9, `locomotion clips present (${locomotion.length})`);
  assert(locomotion.some((c) => c.id === 'walk-loop'), 'walk-loop is searchable');

  const tagged = listClips(pack, { tag: 'walk' });
  assert(tagged.length > 0 && tagged.every((c) => c.tags.includes('walk')));

  const walk = pack.clips.find((c) => c.id === 'walk-loop')!;
  assert(walk.loop, 'Walk_Loop is a loop');
  assert(Math.abs(walk.durationS - 1.33) < 0.05, `walk duration ~1.33s (${walk.durationS})`);
});
