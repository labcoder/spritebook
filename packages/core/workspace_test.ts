import { assert, assertEquals, assertNotEquals, assertRejects } from 'jsr:@std/assert@1';
import type { CharacterManifest } from '@spritebook/schema';
import {
  CANONICAL_MODEL,
  canonicalJson,
  CHARACTER_SCHEMA_VERSION,
  CharacterManifestSchema,
  MANIFEST_FILE,
  parseWith,
  RAW_MODEL,
  RESULT_PREFLIGHT,
} from '@spritebook/schema';
import {
  createWorkspace,
  nextResultId,
  readWorkspace,
  resultPaths,
  sourceImagePath,
  storeSourceImage,
  workspacePaths,
} from './workspace.ts';

const NOW = () => '2026-07-12T00:00:00Z';
const SHA_A = 'a'.repeat(64);

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'spritebook-workspace-' });
  try {
    await fn(dir.replaceAll('\\', '/'));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function newCharacter(workspace: string) {
  return createWorkspace({
    workspace,
    characterId: 'brave-knight',
    displayName: 'Brave Knight',
    source: { kind: 'image', originalFilename: 'knight.png', sha256: SHA_A },
    now: NOW,
  });
}

/** A manifest with the given receipts, built straight through the schema. */
function manifestWith(
  results: Array<{ id: string; discarded?: boolean }>,
): CharacterManifest {
  return parseWith(CharacterManifestSchema, {
    schemaVersion: CHARACTER_SCHEMA_VERSION,
    id: 'brave-knight',
    displayName: 'Brave Knight',
    createdAt: NOW(),
    source: { kind: 'image', originalFilename: 'knight.png', sha256: SHA_A },
    generation: {
      results: results.map((r) => ({
        id: r.id,
        backend: { modelId: 'fixture-gen', version: '1.0' },
        params: {},
        seed: 7,
        startedAt: NOW(),
        wallTimeS: 1,
        output: { gltfSha256: SHA_A, tris: 12000, kind: 'mesh' },
        discarded: r.discarded ?? false,
      })),
    },
    mirroring: { enabled: false },
  }, 'test CharacterManifest');
}

Deno.test('workspacePaths and resultPaths spell the frozen layout', () => {
  const p = workspacePaths('/tmp/ws', 'brave-knight');
  assertEquals(p.manifest, `/tmp/ws/${MANIFEST_FILE}`);
  assertEquals(p.journal, `/tmp/ws/${MANIFEST_FILE}.journal.ndjson`);
  assertEquals(p.cursor, `/tmp/ws/${MANIFEST_FILE}.journal.cursor`);
  assertEquals(p.sourceDir, '/tmp/ws/source');
  assertEquals(p.resultsDir, '/tmp/ws/results');
  assertEquals(p.canonicalDir, '/tmp/ws/canonical');
  assertEquals(p.canonicalModel, `/tmp/ws/canonical/${CANONICAL_MODEL}`);
  // a trailing separator must not double up
  assertEquals(workspacePaths('/tmp/ws/').manifest, p.manifest);

  const r = resultPaths('/tmp/ws', 'r2');
  assertEquals(r.dir, '/tmp/ws/results/r2');
  assertEquals(r.raw, `/tmp/ws/results/r2/${RAW_MODEL}`);
  assertEquals(r.model, `/tmp/ws/results/r2/${CANONICAL_MODEL}`);
  assertEquals(r.preflight, `/tmp/ws/results/r2/${RESULT_PREFLIGHT}`);
});

Deno.test('workspacePaths and resultPaths refuse ids the schemas reject', () => {
  let threw = false;
  try {
    workspacePaths('/tmp/ws', 'Brave Knight!');
  } catch {
    threw = true;
  }
  assert(threw, 'a non-slug characterId is refused');
  threw = false;
  try {
    resultPaths('/tmp/ws', 'r0');
  } catch {
    threw = true;
  }
  assert(threw, 'r0 is not a legal result id');
});

Deno.test('createWorkspace writes a valid manifest, canonical bytes, empty journal, cursor 0', async () => {
  await withTempDir(async (dir) => {
    const manifest = await newCharacter(dir);
    const p = workspacePaths(dir);

    assertEquals(manifest.id, 'brave-knight');
    assertEquals(manifest.generation.results, []);
    assertEquals(manifest.generation.pickedResultId, undefined);
    assertEquals(manifest.canonicalMesh, undefined, 'nothing is canonical yet');
    assertEquals(manifest.mirroring.enabled, false, 'D-008: mirroring is opt-in');

    const bytes = await Deno.readTextFile(p.manifest);
    assertEquals(bytes, canonicalJson(JSON.parse(bytes)), 'manifest is canonical bytes');
    assertEquals(bytes, canonicalJson(manifest));
    parseWith(CharacterManifestSchema, JSON.parse(bytes), 'manifest on disk');

    assertEquals(await Deno.readTextFile(p.journal), '', 'journal starts empty');
    assertEquals(await Deno.readTextFile(p.cursor), '0', 'cursor starts at 0');
    for (const d of [p.sourceDir, p.resultsDir, p.canonicalDir]) {
      assert((await Deno.stat(d)).isDirectory, `${d} exists`);
    }
    assertEquals((await readWorkspace(dir)).displayName, 'Brave Knight');
  });
});

Deno.test('createWorkspace refuses to overwrite an existing character', async () => {
  await withTempDir(async (dir) => {
    await newCharacter(dir);
    const err = await assertRejects(() => newCharacter(dir), Error);
    assert(err.message.includes(MANIFEST_FILE), 'the message names the manifest path');
    assert(err.message.includes('refusing to overwrite'), err.message);
  });
});

Deno.test('readWorkspace names the path when there is no workspace there', async () => {
  await withTempDir(async (dir) => {
    const err = await assertRejects(() => readWorkspace(`${dir}/nope`), Error);
    assert(err.message.includes(`${dir}/nope/${MANIFEST_FILE}`), err.message);
  });
});

/** A v2 workspace on disk: what a build before D-029 left behind. */
async function writeV2Workspace(dir: string): Promise<void> {
  const paths = workspacePaths(dir);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    paths.manifest,
    JSON.stringify({
      schemaVersion: 2,
      id: 'brave-knight',
      displayName: 'Brave Knight',
      createdAt: NOW(),
      source: { kind: 'image', originalFilename: 'knight.png', sha256: SHA_A },
      preflight: {
        at: NOW(),
        checks: [{ id: 'cutout', status: 'ok', message: 'Background removed cleanly' }],
      },
      generation: { results: [] },
      mirroring: { enabled: false },
    }),
  );
  await Deno.writeTextFile(paths.journal, '');
  await Deno.writeTextFile(paths.cursor, '0');
}

Deno.test('readWorkspace upgrades an older manifest instead of refusing it', async () => {
  // The gate this closes: `schemaVersion: z.literal(3)` rejects a v2 document
  // outright, so before the loaders migrated, bumping the version turned every
  // existing workspace into "that directory is not a SpriteBook workspace".
  // migrateCharacterManifest has existed since P1-T2 with no production caller.
  await withTempDir(async (dir) => {
    await writeV2Workspace(dir);
    const manifest = await readWorkspace(dir);
    assertEquals(manifest.schemaVersion, CHARACTER_SCHEMA_VERSION);
    assertEquals(manifest.displayName, 'Brave Knight', 'the rest of the document survives');
    assert(!('preflight' in manifest), 'v3 drops the manifest copy of the report');
  });
});

Deno.test('reading an old workspace does not rewrite it; the first WRITE does', async () => {
  // Upgrade-on-write. A read that silently rewrote the file would mutate a
  // workspace the user only looked at - and would do it outside the journal,
  // which is the one thing law 7 forbids.
  await withTempDir(async (dir) => {
    await writeV2Workspace(dir);
    const before = await Deno.readTextFile(workspacePaths(dir).manifest);
    await readWorkspace(dir);
    assertEquals(await Deno.readTextFile(workspacePaths(dir).manifest), before, 'untouched');

    const { renameCharacter } = await import('./roster.ts');
    await renameCharacter(dir, 'Sir Bravery', { now: NOW });
    const after = JSON.parse(await Deno.readTextFile(workspacePaths(dir).manifest));
    assertEquals(after.schemaVersion, CHARACTER_SCHEMA_VERSION, 'persisted at the new version');
    assertEquals(after.preflight, undefined);
    assertEquals(after.displayName, 'Sir Bravery');
  });
});

Deno.test('storeSourceImage is content-addressed and idempotent', async () => {
  await withTempDir(async (dir) => {
    await newCharacter(dir);
    const imagePath = `${dir}/knight.png`;
    await Deno.writeFile(imagePath, new Uint8Array([1, 2, 3, 4]));

    const first = await storeSourceImage(dir, imagePath);
    assertEquals(first.originalFilename, 'knight.png');
    assertEquals(first.storedPath, `${dir}/source/${first.sha256}.png`, 'named by content');
    assertEquals(await Deno.readFile(first.storedPath), new Uint8Array([1, 2, 3, 4]));
    const stamp = (await Deno.stat(first.storedPath)).mtime?.getTime();

    // same bytes -> same path, and the file is left alone rather than rewritten
    const again = await storeSourceImage(dir, imagePath);
    assertEquals(again.storedPath, first.storedPath);
    assertEquals(again.sha256, first.sha256);
    assertEquals((await Deno.stat(first.storedPath)).mtime?.getTime(), stamp, 'not rewritten');

    // a copy under a different name is still the same content, same path
    const copyPath = `${dir}/renamed.png`;
    await Deno.writeFile(copyPath, new Uint8Array([1, 2, 3, 4]));
    const copy = await storeSourceImage(dir, copyPath);
    assertEquals(copy.storedPath, first.storedPath);
    assertEquals(copy.originalFilename, 'renamed.png', 'the chosen name is still reported');
  });
});

Deno.test('storeSourceImage gives two different images two paths', async () => {
  await withTempDir(async (dir) => {
    await newCharacter(dir);
    await Deno.writeFile(`${dir}/a.png`, new Uint8Array([1, 2, 3]));
    await Deno.writeFile(`${dir}/b.png`, new Uint8Array([9, 9, 9]));
    const a = await storeSourceImage(dir, `${dir}/a.png`);
    const b = await storeSourceImage(dir, `${dir}/b.png`);
    assertNotEquals(a.sha256, b.sha256);
    assertNotEquals(a.storedPath, b.storedPath);
    assert((await Deno.stat(a.storedPath)).isFile);
    assert((await Deno.stat(b.storedPath)).isFile);
  });
});

Deno.test('storeSourceImage names the file it could not read', async () => {
  await withTempDir(async (dir) => {
    await newCharacter(dir);
    const err = await assertRejects(() => storeSourceImage(dir, `${dir}/missing.png`), Error);
    assert(err.message.includes('missing.png'), err.message);
  });
});

Deno.test('nextResultId counts up and never reuses a discarded id', () => {
  assertEquals(nextResultId(manifestWith([])), 'r1');
  assertEquals(nextResultId(manifestWith([{ id: 'r1' }])), 'r2');
  assertEquals(nextResultId(manifestWith([{ id: 'r1' }, { id: 'r2' }])), 'r3');

  // r1 discarded, r2 and r3 alive: the next id is r4, NOT the freed r1
  const afterDiscard = manifestWith([
    { id: 'r1', discarded: true },
    { id: 'r2' },
    { id: 'r3' },
  ]);
  assertEquals(nextResultId(afterDiscard), 'r4');

  // every result discarded — history is still history
  const allGone = manifestWith([
    { id: 'r1', discarded: true },
    { id: 'r2', discarded: true },
  ]);
  assertEquals(nextResultId(allGone), 'r3');
});

Deno.test('sourceImagePath: one derivation, correct for extension-less names', async () => {
  const dir = await Deno.makeTempDir();
  try {
    // storeSourceImage is the writer; sourceImagePath must agree with it for
    // EVERY filename shape, including ones with no extension and dotfiles —
    // two callers hand-rolled this and both mis-handled the no-dot case
    for (const [i, name] of ['cutout.png', 'cutout', '.hidden', 'a.b.c.png'].entries()) {
      const ws = `${dir}/ws-${i}`;
      const srcDir = `${dir}/src-${i}`;
      await Deno.mkdir(srcDir, { recursive: true });
      const src = `${srcDir}/${name}`;
      await Deno.writeFile(src, new Uint8Array([1, 2, 3, 4]));
      const stored = await storeSourceImage(ws, src);
      const manifest = await createWorkspace({
        workspace: ws,
        characterId: 'hero' as never,
        displayName: 'hero',
        source: { kind: 'image', originalFilename: stored.originalFilename, sha256: stored.sha256 },
      });
      assertEquals(
        sourceImagePath(ws, manifest),
        stored.storedPath,
        `derivation matches the writer for "${name}"`,
      );
      await Deno.stat(sourceImagePath(ws, manifest)); // the file is really there
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
