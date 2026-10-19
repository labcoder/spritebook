import { rejects } from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Bytes } from './dist/cache.js';
/**
 * `clone` and `rename` — the two verbs the identity law (D-011) makes cheap.
 * The rename half re-proves what P1 proved at the cache level (see
 * cache_test.ts "displayName rename causes ZERO cache invalidation"); here we
 * prove the VERB honors it, since a verb that rewrote the id would invalidate
 * everything while looking harmless.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { CharacterId } from '@spritebook/schema';
import { canonicalJson } from '@spritebook/schema';
import { createWorkspace, readWorkspace, workspacePaths } from './dist/workspace.js';
import { cloneCharacter, renameCharacter } from './dist/roster.js';

const NOW = () => '2026-07-19T00:00:00Z';

async function character(name = 'knight'): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  await createWorkspace({
    workspace: dir,
    characterId: 'knight' as CharacterId,
    displayName: name,
    source: { kind: 'mesh', originalFilename: 'k.glb', sha256: 'a'.repeat(64) },
    now: NOW,
  });
  // a file in every subdirectory, so the clone has something real to carry
  await fs.writeFile(`${dir}/source/${'a'.repeat(64)}.glb`, 'source bytes');
  await fs.mkdir(`${dir}/results/r1`, { recursive: true });
  await fs.writeFile(`${dir}/results/r1/model.glb`, 'result bytes');
  await fs.mkdir(`${dir}/canonical`, { recursive: true });
  await fs.writeFile(`${dir}/canonical/model.glb`, 'canonical bytes');
  // a canonical mesh, so the cache-key derivation has something to key on
  const paths = workspacePaths(dir);
  const doc = JSON.parse(await fs.readFile(paths.manifest, 'utf8'));
  doc.canonicalMesh = {
    gltfSha256: await sha256Bytes(new Uint8Array(await fs.readFile(`${dir}/canonical/model.glb`))),
    heightM: 1.8,
    texturedBy: 'backend',
    reprojected: false,
  };
  doc.generation = {
    results: [{
      id: 'r1',
      backend: { modelId: 'fixture-gen', version: '1.0.0' },
      params: {},
      seed: 0,
      startedAt: '2026-07-19T00:00:00Z',
      wallTimeS: 1,
      output: { gltfSha256: 'b'.repeat(64), tris: 100, kind: 'mesh' },
      discarded: false,
    }],
    pickedResultId: 'r1',
  };
  doc.rig = {
    track: 'A',
    skeletonProfile: 'ual-humanoid',
    jointCount: 66,
    jointEdits: [],
    orientationFixes: [],
    accepted: true,
  };
  await fs.writeFile(paths.manifest, canonicalJson(doc));
  return dir;
}

test('rename changes one field and nothing else', async () => {
  const ws = await character('Sir Reginald');
  try {
    const before = JSON.parse(await fs.readFile(workspacePaths(ws).manifest, 'utf8'));
    const after = await renameCharacter(ws, 'Dame Reginalda', { now: NOW });

    assertEquals(after.displayName, 'Dame Reginalda');
    assertEquals(after.id, before.id, 'the immutable id is untouched');
    // every other field is byte-identical
    // DEEP key-sorted, so nested field order cannot fake a difference
    const strip = (m: Record<string, unknown>) => {
      const { displayName: _d, ...rest } = m;
      return deepSorted(rest);
    };
    assertEquals(
      strip(JSON.parse(JSON.stringify(after))),
      strip(before),
      'rename touches ONLY displayName',
    );

    // and the journal grew by exactly one undoable patch
    const lines = (await fs.readFile(workspacePaths(ws).journal, 'utf8'))
      .split('\n').filter((l) => l);
    assertEquals(lines.length, 1);
    assert(JSON.parse(lines[0]).inverse.length > 0, 'the rename is undoable');
  } finally {
    await fs.rm(ws, { recursive: true });
  }
});

test('clone mints a new id, carries the work, and drops the borrowed bake', async () => {
  const src = await character('Knight');
  const dest = `${src}-clone`;
  try {
    const clone = await cloneCharacter(src, dest, { id: 'knight-two', now: NOW });

    assertEquals(clone.id, 'knight-two', 'a NEW immutable id');
    assertEquals(clone.displayName, 'Knight copy', 'a name that says what it is');
    assertEquals(clone.source.sha256, 'a'.repeat(64), 'the source record came along');
    assertEquals(
      (clone as { lastBakeId?: string }).lastBakeId,
      undefined,
      'the copy has baked nothing yet - it must not point at the source bake',
    );

    // the real work came with it
    assertEquals(await fs.readFile(`${dest}/results/r1/model.glb`, 'utf8'), 'result bytes');
    assertEquals(await fs.readFile(`${dest}/canonical/model.glb`, 'utf8'), 'canonical bytes');

    // history starts by saying where it came from
    const first = JSON.parse(
      (await fs.readFile(workspacePaths(dest).journal, 'utf8')).split('\n')[0],
    );
    assert(
      String(first.label).includes('Clone of knight'),
      `provenance in history: ${first.label}`,
    );

    // and the SOURCE is untouched
    const original = JSON.parse(await fs.readFile(workspacePaths(src).manifest, 'utf8'));
    assertEquals(original.id, 'knight');
    assertEquals(original.displayName, 'Knight');
  } finally {
    await fs.rm(src, { recursive: true });
    await fs.rm(dest, { recursive: true }).catch(() => {});
  }
});

test('clone refuses to reuse the id or overwrite a character', async () => {
  const src = await character();
  const dest = `${src}-clone`;
  try {
    await assertRejects(() => cloneCharacter(src, dest, { id: 'knight', now: NOW }),
      Error,
      'NEW id',);
    await cloneCharacter(src, dest, { id: 'knight-two', now: NOW });
    await assertRejects(() => cloneCharacter(src, dest, { id: 'knight-three', now: NOW }),
      Error,
      'never overwrites',);
  } finally {
    await fs.rm(src, { recursive: true });
    await fs.rm(dest, { recursive: true }).catch(() => {});
  }
});

test('rename to the same name is refused rather than journaling a no-op', async () => {
  const ws = await character('Same');
  try {
    await assertRejects(() => renameCharacter(ws, 'Same', { now: NOW }), Error, 'already called');
  } finally {
    await fs.rm(ws, { recursive: true });
  }
});

/** JSON with EVERY object's keys sorted, at any depth. */
function deepSorted(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return val;
  });
}

test('undo on a fresh clone actually undoes something', async () => {
  // It used to journal `replace /displayName` to the value the document
  // already held, so `undo` reported "undid: Clone of knight" and changed
  // nothing. An undo that visibly does nothing is how a user stops trusting
  // the stack, and the label made it look deliberate.
  const src = await character('Brave Knight');
  const dest = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await fs.rm(dest, { recursive: true });
    await cloneCharacter(src, dest, { id: 'squire' as CharacterId, now: NOW });

    const patch = JSON.parse(
      (await fs.readFile(workspacePaths(dest).journal, 'utf8')).split('\n')[0],
    );
    assertEquals(patch.op[0], {
      op: 'replace',
      path: '/displayName',
      value: 'Brave Knight copy',
    });
    assertEquals(patch.inverse[0], {
      op: 'replace',
      path: '/displayName',
      value: 'Brave Knight',
    }, 'the inverse restores the source name, not the value already there');
  } finally {
    await fs.rm(src, { recursive: true });
    await fs.rm(dest, { recursive: true });
  }
});

test('a clone that keeps its source name journals nothing at all', async () => {
  // Then there is genuinely nothing to undo, and an empty journal says so —
  // the shape createWorkspace already lays down for a fresh character.
  const src = await character('Brave Knight');
  const dest = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await fs.rm(dest, { recursive: true });
    await cloneCharacter(src, dest, {
      id: 'squire' as CharacterId,
      displayName: 'Brave Knight',
      now: NOW,
    });
    assertEquals(await fs.readFile(workspacePaths(dest).journal, 'utf8'), '');
    assertEquals(await fs.readFile(workspacePaths(dest).cursor, 'utf8'), '0');
  } finally {
    await fs.rm(src, { recursive: true });
    await fs.rm(dest, { recursive: true });
  }
});

test('clone cannot overwrite a destination whose creation intent is committed', async () => {
  const source = await character('Source'), dest = await character('Accepted destination');
  try {
    await fs.writeFile(`${source}/payload.txt`, 'would overwrite');
    await fs.writeFile(`${dest}/payload.txt`, 'accepted');
    const path = workspacePaths(dest).manifest;
    const doc = await readWorkspace(dest);
    await fs.writeFile(
      `${path}.pending.json`,
      JSON.stringify({ version: 1, doc, patches: [], cursor: 0 }),
    );
    await fs.rm(path);
    await assertRejects(() => cloneCharacter(source, dest, { id: 'copy' }),
      Error,
      'already exists',);
    assertEquals(await fs.readFile(`${dest}/payload.txt`, 'utf8'), 'accepted');
    assertEquals((await readWorkspace(dest)).displayName, 'Accepted destination');
  } finally {
    await fs.rm(source, { recursive: true });
    await fs.rm(dest, { recursive: true });
  }
});

test('clone refuses corrupt canonical source bytes before publishing a manifest', async () => {
  const source = await character('Source'), dest = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await fs.writeFile(workspacePaths(source).canonicalModel, 'corrupt');
    await assertRejects(() => cloneCharacter(source, dest, { id: 'copy' }), Error, 'hash mismatch');
    await rejects(() => fs.stat(workspacePaths(dest).manifest), { code: 'ENOENT' });
  } finally {
    await fs.rm(source, { recursive: true });
    await fs.rm(dest, { recursive: true });
  }
});

test('clone refuses a nested destination, including a dot-prefixed child', async () => {
  const source = await character();
  try {
    for (const child of ['child', '..child']) {
      await assertRejects(() => cloneCharacter(source, `${source}/${child}`, { id: 'copy' }),
        Error,
        'outside the source',);
    }
  } finally {
    await fs.rm(source, { recursive: true });
  }
});
