import { promises as fs } from 'node:fs';
import { test } from 'node:test';
/**
 * The gallery projection: any manifest the CLI would accept renders a card,
 * and a manifest it cannot project yields a card that SAYS so — the gallery
 * never silently drops a character (that is how a corrupted workspace gets
 * noticed, not hidden). Run against the REAL exit workspace when present, so
 * the projection is pinned to the manifest the pipeline actually writes.
 */
import { assert, assertEquals } from '@std/assert';
import { toCard } from './src/manifest.ts';

// The manifest is a SNAPSHOT of the real exit workspace (fixtures/), taken
// 2026-08-07 after the maintainer's first UX pass recorded a re-rig, an
// acceptance, and a new pick. The live workspace stopped being a fixture the
// day it became the maintainer's playground - pinning against it meant every
// UX session broke the suite.
test('the real p3-exit manifest projects with every card field', async () => {
  const raw = await fs.readFile(new URL('./fixtures/p3-exit-character.json', import.meta.url), 'utf8');
  const c = toCard('bulma-fixed', JSON.parse(raw));
  assertEquals(c.id, 'bulma-fixed');
  assertEquals(
    c.problem,
    undefined,
    'a pipeline-written manifest projects cleanly',
  );
  assertEquals(c.stylePresetId, 'pixel');
  assert(c.rig && c.rig.track === 'B' && c.rig.jointCount === 52);
  assertEquals(
    c.rig.accepted,
    true,
    'the recorded acceptance reaches the card',
  );
  assert(typeof c.lastBakeId === 'string');
  assert(typeof c.heightM === 'number');
});

test('a malformed manifest yields a labeled card, never a blank', () => {
  for (const bad of [null, 42, 'nope', {}, { id: '' }, { id: 7 }]) {
    const c = toCard('some/dir', bad);
    assertEquals(c.dir, 'some/dir');
    assert(c.displayName.length > 0, 'always renderable');
    assert(c.problem, `problem stated for ${JSON.stringify(bad)}`);
  }
});

test('partial manifests project what they have and nothing invented', () => {
  const c = toCard('d', { id: 'sprout', displayName: 'Sprout' });
  assertEquals(c.problem, undefined);
  assertEquals(c.displayName, 'Sprout');
  assertEquals(c.rig, undefined);
  assertEquals(c.stylePresetId, undefined);
  assertEquals(c.lastBakeId, undefined);
});
