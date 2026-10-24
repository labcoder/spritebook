import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { assert, assertEquals, assertThrows } from '@std/assert';
import { canonicalJson, ManifestPatchSchema, parseWith } from '@spritebook/schema';
import { applyPatchOps, ManifestJournal } from './dist/journal.js';

const now = () => '2026-07-12T00:00:00Z';
const target = { kind: 'character', id: 'brave-knight' } as const;

async function loadFixtureDoc(): Promise<Record<string, unknown>> {
  const url = new URL('../schema/fixtures/valid/character-manifest.json', import.meta.url);
  return JSON.parse(await fs.readFile(url, 'utf8'));
}

test('acceptance: undo of a 5-patch chain restores the manifest byte-for-byte', async () => {
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

test('redo replays forward; undo/redo interleave correctly', async () => {
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

test('commits produce valid ManifestPatch objects with precomputed inverses', async () => {
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

test('failing op leaves the document untouched (all-or-nothing)', async () => {
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

// --- the inverse of `add` depends on what was already there ------------------
// applyOp implements RFC-6902 `add` on a present OBJECT member as an
// OVERWRITE, so "inverse of add is remove" is only true when the member was
// absent. These four cases pin all of it.

test('add over an EXISTING object member inverts to replace, not remove', async () => {
  const original = await loadFixtureDoc();
  const originalBytes = canonicalJson(original);
  const journal = new ManifestJournal(original, { now });

  const patch = journal.commit({
    target,
    op: [{ op: 'add', path: '/displayName', value: 'Renamed' }],
    label: 'Rename via add',
  });

  assertEquals(patch.inverse, [{ op: 'replace', path: '/displayName', value: 'Brave Knight' }]);
  assertEquals(journal.doc.displayName, 'Renamed');
  journal.undo();
  assertEquals(journal.doc.displayName, 'Brave Knight', 'undo restores, never deletes');
  assertEquals(journal.canonicalBytes, originalBytes, 'byte-for-byte restoration');
});

test('add over an existing OBJECT value restores the whole old subtree', async () => {
  const original = await loadFixtureDoc();
  const originalBytes = canonicalJson(original);
  const journal = new ManifestJournal(original, { now });

  journal.commit({
    target,
    op: [{ op: 'add', path: '/look/overrides', value: { ramp: { stops: 3 } } }],
    label: 'Replace overrides via add',
  });
  // a later patch mutating the NEW subtree must not reach the captured old one
  journal.commit({
    target,
    op: [{ op: 'replace', path: '/look/overrides/ramp/stops', value: 5 }],
    label: 'Tweak ramp',
  });

  journal.undo();
  journal.undo();
  assertEquals(journal.canonicalBytes, originalBytes, 'the old overrides came back intact');
});

test('add of an ABSENT object member still inverts to remove', async () => {
  const original = await loadFixtureDoc();
  const originalBytes = canonicalJson(original);
  const journal = new ManifestJournal(original, { now });

  const patch = journal.commit({
    target,
    op: [{ op: 'add', path: '/look/overrides/ramp', value: { stops: 3, rimStrength: 0.5 } }],
    label: 'Add ramp',
  });

  assertEquals(patch.inverse, [{ op: 'remove', path: '/look/overrides/ramp' }]);
  journal.undo();
  assertEquals(journal.canonicalBytes, originalBytes);
});

test('array add stays an insert: both /- and an index invert to remove', async () => {
  const original = await loadFixtureDoc();
  const originalBytes = canonicalJson(original);
  const journal = new ManifestJournal(original, { now });

  const appended = journal.commit({
    target,
    op: [{ op: 'add', path: '/detailLayers/-', value: { id: 'crest', uvDecalPng: 'crest.png' } }],
    label: 'Append crest',
  });
  // '-' is resolved to the concrete index at commit time
  assertEquals(appended.inverse, [{ op: 'remove', path: '/detailLayers/1' }]);

  const inserted = journal.commit({
    target,
    op: [{ op: 'add', path: '/detailLayers/0', value: { id: 'tattoo', uvDecalPng: 't.png' } }],
    label: 'Insert tattoo first',
  });
  assertEquals(inserted.inverse, [{ op: 'remove', path: '/detailLayers/0' }]);

  journal.undo();
  journal.undo();
  assertEquals(journal.canonicalBytes, originalBytes, 'neither insert destroyed a sibling');
});

test('add of a prototype-chain key is an addition, not an overwrite', () => {
  // `'toString' in parent` is true for every plain object, so reading presence
  // that way would call structuredClone on an inherited function and throw
  const journal = new ManifestJournal({ keep: 1 }, { now });

  const patch = journal.commit({
    target,
    op: [{ op: 'add', path: '/toString', value: 'not a function' }],
    label: 'Shadow a prototype key',
  });

  assertEquals(patch.inverse, [{ op: 'remove', path: '/toString' }]);
  assertEquals(journal.doc, { keep: 1, toString: 'not a function' });
  journal.undo();
  assertEquals(journal.doc, { keep: 1 });
});

test('JSON Pointer escapes (~0 ~1) resolve correctly', () => {
  const journal = new ManifestJournal({ 'a/b': { 'c~d': 1 } }, { now });
  journal.commit({
    target,
    op: [{ op: 'replace', path: '/a~1b/c~0d', value: 2 }],
    label: 'escaped',
  });
  assertEquals(journal.doc, { 'a/b': { 'c~d': 2 } });
});

test('patch commit and replay refuse prototype paths without changing state or globals', () => {
  for (
    const path of [
      '/source/__proto__/auditFlag',
      '/source/constructor/prototype/auditFlag',
      '/__proto__',
    ]
  ) {
    const journal = new ManifestJournal({ source: {}, keep: 1 }, { now });
    const op = { op: 'add', path, value: { auditFlag: 1 } } as const;
    assertThrows(() => journal.commit({ target, op: [op], label: 'Unsafe patch' }));
    assertThrows(() => applyPatchOps(journal.doc, [op]));
    assertThrows(() =>
      journal.replay({
        seq: 0,
        at: now(),
        target,
        op: [op],
        inverse: [{ op: 'remove', path }],
        label: 'Unsafe stored patch',
      })
    );
    assertEquals(journal.doc, { source: {}, keep: 1 });
    assertEquals(journal.undoDepth, 0);
    assertEquals(Object.hasOwn(Object.prototype, 'auditFlag'), false);
  }
  assertThrows(() => applyPatchOps({}, [{ op: 'replace', path: '/toString', value: 1 }]));
  assertThrows(() => applyPatchOps({}, [{ op: 'add', path: '/toString/nested', value: 1 }]));
});
