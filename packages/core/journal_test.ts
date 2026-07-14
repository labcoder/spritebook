import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { canonicalJson, ManifestPatchSchema, parseWith } from '@spritebook/schema';
import { ManifestJournal } from './journal.ts';

const now = () => '2026-07-12T00:00:00Z';
const target = { kind: 'character', id: 'brave-knight' } as const;

async function loadFixtureDoc(): Promise<Record<string, unknown>> {
  const url = new URL('../schema/fixtures/valid/character-manifest.json', import.meta.url);
  return JSON.parse(await Deno.readTextFile(url));
}

Deno.test('acceptance: undo of a 5-patch chain restores the manifest byte-for-byte', async () => {
  const original = await loadFixtureDoc();
  const originalBytes = canonicalJson(original);
  const journal = new ManifestJournal(original, { now });

  journal.commit({
    target,
    op: [{ op: 'replace', path: '/displayName', value: 'Sir Bravery' }],
    label: 'Rename',
  });
  journal.commit({
    target,
    op: [{ op: 'add', path: '/detailLayers/-', value: { id: 'crest', uvDecalPng: 'crest.png' } }],
    label: 'Add crest decal',
  });
  journal.commit({
    target,
    op: [{ op: 'replace', path: '/rig/jointEdits/0/delta', value: [0, 0.02, 0] }],
    label: 'Nudge shoulder',
  });
  journal.commit({
    target,
    op: [{ op: 'remove', path: '/attachments/0' }],
    label: 'Remove sword',
  });
  journal.commit({
    target,
    op: [
      { op: 'replace', path: '/mirroring/enabled', value: true },
      { op: 'add', path: '/look/overrides/ramp', value: { stops: 3, rimStrength: 0.5 } },
    ],
    label: 'Enable mirroring + tweak ramp',
  });

  assert(journal.canonicalBytes !== originalBytes, 'patches changed the document');
  assertEquals(journal.undoDepth, 5);

  for (let i = 0; i < 5; i++) journal.undo();
  assertEquals(journal.canonicalBytes, originalBytes, 'byte-for-byte restoration');
  assertEquals(journal.undoDepth, 0);
  assertEquals(journal.redoDepth, 5);
});

Deno.test('redo replays forward; undo/redo interleave correctly', async () => {
  const journal = new ManifestJournal(await loadFixtureDoc(), { now });
  journal.commit({
    target,
    op: [{ op: 'replace', path: '/displayName', value: 'A' }],
    label: 'to A',
  });
  const afterA = journal.canonicalBytes;
  journal.commit({
    target,
    op: [{ op: 'replace', path: '/displayName', value: 'B' }],
    label: 'to B',
  });
  const afterB = journal.canonicalBytes;

  journal.undo();
  assertEquals(journal.canonicalBytes, afterA);
  journal.redo();
  assertEquals(journal.canonicalBytes, afterB);
  journal.undo();
  journal.undo();
  // a fresh commit clears the redo stack
  journal.commit({
    target,
    op: [{ op: 'replace', path: '/displayName', value: 'C' }],
    label: 'to C',
  });
  assertEquals(journal.redoDepth, 0);
  assertEquals(journal.redo(), undefined);
});

Deno.test('commits produce valid ManifestPatch objects with precomputed inverses', async () => {
  const journal = new ManifestJournal(await loadFixtureDoc(), { now });
  const patch = journal.commit({
    target,
    op: [
      { op: 'remove', path: '/detailLayers/0' },
      { op: 'replace', path: '/displayName', value: 'X' },
    ],
    label: 'combo',
  });
  parseWith(ManifestPatchSchema, patch, 'committed patch');
  assertEquals(patch.inverse.length, patch.op.length);
  // inverse of the remove restores the exact removed value
  const restore = patch.inverse.find((o) => o.op === 'add');
  assert(restore && restore.path === '/detailLayers/0');
});

Deno.test('failing op leaves the document untouched (all-or-nothing)', async () => {
  const journal = new ManifestJournal(await loadFixtureDoc(), { now });
  const before = journal.canonicalBytes;
  assertThrows(() =>
    journal.commit({
      target,
      op: [
        { op: 'replace', path: '/displayName', value: 'X' },
        { op: 'remove', path: '/no/such/path' },
      ],
      label: 'bad combo',
    })
  );
  assertEquals(journal.canonicalBytes, before);
  assertEquals(journal.undoDepth, 0);
});

Deno.test('JSON Pointer escapes (~0 ~1) resolve correctly', () => {
  const journal = new ManifestJournal({ 'a/b': { 'c~d': 1 } }, { now });
  journal.commit({
    target,
    op: [{ op: 'replace', path: '/a~1b/c~0d', value: 2 }],
    label: 'escaped',
  });
  assertEquals(journal.doc, { 'a/b': { 'c~d': 2 } });
});
