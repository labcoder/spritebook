import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import type { GenerationResult, ManifestPatch } from '@spritebook/schema';
import {
  canonicalJson,
  GenerationResultSchema,
  ManifestPatchSchema,
  parseWith,
} from '@spritebook/schema';
import { applyPatchOps } from './journal.ts';
import { createWorkspace, readWorkspace, workspacePaths } from './workspace.ts';
import { appendGenerationResult, discardResult, pickResult, setCanonicalMesh } from './receipts.ts';

const NOW = () => '2026-07-12T00:00:00Z';
const sha = (c: string) => c.repeat(64);

async function withCharacter(fn: (dir: string) => Promise<void>): Promise<void> {
  const raw = await Deno.makeTempDir({ prefix: 'spritebook-receipts-' });
  const dir = raw.replaceAll('\\', '/');
  try {
    await createWorkspace({
      workspace: dir,
      characterId: 'brave-knight',
      displayName: 'Brave Knight',
      source: { kind: 'image', originalFilename: 'knight.png', sha256: sha('a') },
      now: NOW,
    });
    await fn(dir);
  } finally {
    await Deno.remove(raw, { recursive: true });
  }
}

function makeResult(id: string, gltfSha256 = sha('b')): GenerationResult {
  return parseWith(GenerationResultSchema, {
    id,
    backend: { modelId: 'fixture-gen', version: '1.0' },
    params: { quality: 'high' },
    seed: 7,
    startedAt: NOW(),
    wallTimeS: 12.5,
    output: { gltfSha256, tris: 12000, textureRes: 1024, kind: 'mesh' },
    discarded: false,
  }, 'test GenerationResult');
}

async function journalLines(dir: string): Promise<ManifestPatch[]> {
  const text = await Deno.readTextFile(workspacePaths(dir).journal);
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l, i) => parseWith(ManifestPatchSchema, JSON.parse(l), `journal line ${i + 1}`));
}

const cursorOf = async (dir: string) =>
  Number((await Deno.readTextFile(workspacePaths(dir).cursor)).trim());
const manifestBytes = (dir: string) => Deno.readTextFile(workspacePaths(dir).manifest);

/**
 * A line-for-line mirror of the `undo` branch in packages/cli/mod.ts: read the
 * document, the journal and the cursor; take the LAST APPLIED patch; replay its
 * PRECOMPUTED inverse through the same applyPatchOps primitive the CLI calls;
 * rewrite the manifest as canonical bytes and step the cursor back one.
 *
 * Mirrored rather than imported because @spritebook/cli depends on core, not
 * the other way round — but every mechanic below is the real one.
 */
async function cliUndo(dir: string): Promise<ManifestPatch> {
  const p = workspacePaths(dir);
  const doc = JSON.parse(await Deno.readTextFile(p.manifest)) as Record<string, unknown>;
  const patches = await journalLines(dir);
  const cursorText = await Deno.readTextFile(p.cursor).catch(() => String(patches.length));
  const cursor = Number(cursorText.trim());
  assert(Number.isInteger(cursor) && cursor >= 0 && cursor <= patches.length, 'cursor is sane');
  assert(cursor > 0, 'there is something to undo');
  const patch = patches[cursor - 1];
  const next = applyPatchOps(doc, patch.inverse);
  await Deno.writeTextFile(p.manifest, canonicalJson(next));
  await Deno.writeTextFile(p.cursor, String(cursor - 1));
  return patch;
}

Deno.test('appendGenerationResult journals one patch and advances the cursor', async () => {
  await withCharacter(async (dir) => {
    const manifest = await appendGenerationResult(dir, makeResult('r1'), { now: NOW });
    assertEquals(manifest.generation.results.length, 1);
    assertEquals(manifest.generation.results[0].id, 'r1');

    const patches = await journalLines(dir);
    assertEquals(patches.length, 1, 'exactly one journal line');
    assertEquals(patches[0].seq, 0);
    assertEquals(patches[0].target, { kind: 'character', id: 'brave-knight' });
    assertEquals(patches[0].op.length, 1);
    assertEquals(patches[0].op[0].path, '/generation/results/-');
    assertEquals(patches[0].inverse[0], { op: 'remove', path: '/generation/results/0' });
    assertEquals(patches[0].label, 'Generate r1 (fixture-gen)', 'reads like undo-stack history');
    assertEquals(await cursorOf(dir), 1);

    const bytes = await manifestBytes(dir);
    assertEquals(bytes, canonicalJson(JSON.parse(bytes)), 'manifest stays canonical bytes');
    assertEquals(canonicalJson(await readWorkspace(dir)), bytes, 're-reading validates');

    // a second append continues the sequence rather than restarting it
    await appendGenerationResult(dir, makeResult('r2'), { now: NOW });
    const after = await journalLines(dir);
    assertEquals(after.length, 2);
    assertEquals(after.map((p) => p.seq), [0, 1]);
    assertEquals(await cursorOf(dir), 2);
  });
});

Deno.test('appendGenerationResult refuses a result id that is already recorded', async () => {
  await withCharacter(async (dir) => {
    await appendGenerationResult(dir, makeResult('r1'), { now: NOW });
    const err = await assertRejects(
      () => appendGenerationResult(dir, makeResult('r1'), { now: NOW }),
      Error,
    );
    assert(err.message.includes('never reused'), err.message);
    assertEquals((await journalLines(dir)).length, 1, 'a refusal writes nothing');
    assertEquals(await cursorOf(dir), 1);
  });
});

Deno.test('acceptance: `undo` after a second generate restores the previous bytes', async () => {
  await withCharacter(async (dir) => {
    await appendGenerationResult(dir, makeResult('r1'), { now: NOW });
    const afterFirst = await manifestBytes(dir);

    await appendGenerationResult(dir, makeResult('r2', sha('c')), { now: NOW });
    const afterSecond = await manifestBytes(dir);
    assert(afterSecond !== afterFirst, 'the second receipt changed the document');
    assertEquals(await cursorOf(dir), 2);

    const undone = await cliUndo(dir);
    assertEquals(undone.label, 'Generate r2 (fixture-gen)');
    assertEquals(await manifestBytes(dir), afterFirst, 'byte-for-byte restoration');
    assertEquals(await cursorOf(dir), 1, 'the cursor stepped back');
    assertEquals((await journalLines(dir)).length, 2, 'the journal stays append-only');

    const manifest = await readWorkspace(dir);
    assertEquals(manifest.generation.results.map((r) => r.id), ['r1']);
  });
});

Deno.test('a commit after an undo drops the redo tail', async () => {
  await withCharacter(async (dir) => {
    await appendGenerationResult(dir, makeResult('r1'), { now: NOW });
    await appendGenerationResult(dir, makeResult('r2'), { now: NOW });
    await cliUndo(dir);
    assertEquals(await cursorOf(dir), 1);

    // r2 was undone, so r2's id is free again for a differently-seeded attempt
    await appendGenerationResult(dir, makeResult('r2', sha('d')), { now: NOW });
    const patches = await journalLines(dir);
    assertEquals(patches.length, 2, 'the undone patch was replaced, not kept');
    assertEquals(patches.map((p) => p.seq), [0, 1]);
    assertEquals(await cursorOf(dir), 2);

    const manifest = await readWorkspace(dir);
    assertEquals(manifest.generation.results.length, 2);
    assertEquals(manifest.generation.results[1].output.gltfSha256, sha('d'));
  });
});

Deno.test('pickResult sets pickedResultId and writes canonicalMesh', async () => {
  await withCharacter(async (dir) => {
    await appendGenerationResult(dir, makeResult('r1'), { now: NOW });
    await appendGenerationResult(dir, makeResult('r2', sha('c')), { now: NOW });

    const manifest = await pickResult(dir, 'r2', {
      heightM: 1.81,
      texturedBy: 'backend',
      now: NOW,
    });
    assertEquals(manifest.generation.pickedResultId, 'r2');
    assertEquals(manifest.canonicalMesh, {
      gltfSha256: sha('c'),
      heightM: 1.81,
      texturedBy: 'backend',
      reprojected: false,
    });

    const patches = await journalLines(dir);
    assertEquals(patches.length, 3);
    assertEquals(patches[2].label, 'Pick r2');
    // both fields were absent, so both are adds — and both invert to removes
    assertEquals(patches[2].op.map((o) => o.op), ['add', 'add']);
    assertEquals(patches[2].inverse.map((o) => o.op), ['remove', 'remove']);

    // re-picking replaces rather than adds, so undo restores the old pick
    const repick = await pickResult(dir, 'r1', { now: NOW });
    assertEquals(repick.generation.pickedResultId, 'r1');
    assertEquals(repick.canonicalMesh?.gltfSha256, sha('b'));
    assertEquals(repick.canonicalMesh?.heightM, 1.81, 'height carried forward');
    const after = await journalLines(dir);
    assertEquals(after[3].op.map((o) => o.op), ['replace', 'replace']);
    // the inverse replays in REVERSE order, so it ends where the ops began
    assertEquals(after[3].inverse.map((o) => o.path), [
      '/canonicalMesh',
      '/generation/pickedResultId',
    ]);
    assertEquals(after[3].inverse[1], {
      op: 'replace',
      path: '/generation/pickedResultId',
      value: 'r2',
    });
  });
});

Deno.test('pickResult refuses an unknown id and lists what is available', async () => {
  await withCharacter(async (dir) => {
    await appendGenerationResult(dir, makeResult('r1'), { now: NOW });
    await appendGenerationResult(dir, makeResult('r2'), { now: NOW });
    const err = await assertRejects(
      () => pickResult(dir, 'r9', { heightM: 1.8, texturedBy: 'backend', now: NOW }),
      Error,
    );
    assert(err.message.includes('"r9"'), err.message);
    assert(err.message.includes('available: r1, r2'), err.message);
    assertEquals((await journalLines(dir)).length, 2, 'a refusal writes nothing');
  });
});

Deno.test('pickResult refuses a discarded result', async () => {
  await withCharacter(async (dir) => {
    await appendGenerationResult(dir, makeResult('r1'), { now: NOW });
    await appendGenerationResult(dir, makeResult('r2'), { now: NOW });
    await discardResult(dir, 'r1', { now: NOW });

    const err = await assertRejects(
      () => pickResult(dir, 'r1', { heightM: 1.8, texturedBy: 'backend', now: NOW }),
      Error,
    );
    assert(err.message.includes('discarded'), err.message);
    assert(err.message.includes('available: r2'), err.message);
  });
});

Deno.test('pickResult refuses a first pick with no height or texture provenance', async () => {
  await withCharacter(async (dir) => {
    await appendGenerationResult(dir, makeResult('r1'), { now: NOW });

    const noHeight = await assertRejects(() => pickResult(dir, 'r1', { now: NOW }), Error);
    assert(noHeight.message.includes('heightM'), noHeight.message);

    const noTexture = await assertRejects(
      () => pickResult(dir, 'r1', { heightM: 1.8, now: NOW }),
      Error,
    );
    assert(noTexture.message.includes('texturedBy'), noTexture.message);
    assertEquals((await journalLines(dir)).length, 1, 'neither refusal wrote anything');
  });
});

Deno.test('discardResult marks the receipt and keeps its id', async () => {
  await withCharacter(async (dir) => {
    await appendGenerationResult(dir, makeResult('r1'), { now: NOW });
    await appendGenerationResult(dir, makeResult('r2'), { now: NOW });

    const manifest = await discardResult(dir, 'r1', { now: NOW });
    assertEquals(manifest.generation.results.map((r) => r.id), ['r1', 'r2'], 'history is kept');
    assertEquals(manifest.generation.results[0].discarded, true);
    assertEquals(manifest.generation.results[1].discarded, false);

    const patches = await journalLines(dir);
    assertEquals(patches[2].label, 'Discard r1');
    assertEquals(patches[2].op[0], {
      op: 'replace',
      path: '/generation/results/0/discarded',
      value: true,
    });
    assertEquals(patches[2].inverse[0], {
      op: 'replace',
      path: '/generation/results/0/discarded',
      value: false,
    });

    const twice = await assertRejects(() => discardResult(dir, 'r1', { now: NOW }), Error);
    assert(twice.message.includes('already discarded'), twice.message);
  });
});

Deno.test('discardResult refuses to discard the picked result', async () => {
  await withCharacter(async (dir) => {
    await appendGenerationResult(dir, makeResult('r1'), { now: NOW });
    await appendGenerationResult(dir, makeResult('r2'), { now: NOW });
    await pickResult(dir, 'r1', { heightM: 1.8, texturedBy: 'backend', now: NOW });

    const err = await assertRejects(() => discardResult(dir, 'r1', { now: NOW }), Error);
    assert(err.message.includes('pick another result first'), err.message);
    assertEquals((await readWorkspace(dir)).generation.results[0].discarded, false);

    // pick something else and it becomes discardable
    await pickResult(dir, 'r2', { now: NOW });
    const manifest = await discardResult(dir, 'r1', { now: NOW });
    assertEquals(manifest.generation.results[0].discarded, true);
  });
});

Deno.test('setCanonicalMesh flips reprojected and repins the hash', async () => {
  await withCharacter(async (dir) => {
    await appendGenerationResult(dir, makeResult('r1'), { now: NOW });
    await pickResult(dir, 'r1', { heightM: 1.81, texturedBy: 'backend', now: NOW });

    const manifest = await setCanonicalMesh(dir, {
      gltfSha256: sha('e'),
      reprojected: true,
    }, { now: NOW });
    assertEquals(manifest.canonicalMesh, {
      gltfSha256: sha('e'),
      heightM: 1.81,
      texturedBy: 'backend',
      reprojected: true,
    });

    const patches = await journalLines(dir);
    assertEquals(patches[2].label, 'Reproject canonical mesh');
    assertEquals(patches[2].inverse[0].op, 'replace');

    // undoing gets the pre-reprojection mesh back exactly
    await cliUndo(dir);
    assertEquals((await readWorkspace(dir)).canonicalMesh, {
      gltfSha256: sha('b'),
      heightM: 1.81,
      texturedBy: 'backend',
      reprojected: false,
    });
  });
});

Deno.test('setCanonicalMesh refuses before there is a canonical mesh, or with nothing to do', async () => {
  await withCharacter(async (dir) => {
    const none = await assertRejects(
      () => setCanonicalMesh(dir, { reprojected: true }, { now: NOW }),
      Error,
    );
    assert(none.message.includes('pick a generation result first'), none.message);

    await appendGenerationResult(dir, makeResult('r1'), { now: NOW });
    await pickResult(dir, 'r1', { heightM: 1.8, texturedBy: 'backend', now: NOW });
    const empty = await assertRejects(() => setCanonicalMesh(dir, {}, { now: NOW }), Error);
    assert(empty.message.includes('nothing to change'), empty.message);
    assertEquals((await journalLines(dir)).length, 2, 'no empty patch was journaled');
  });
});
