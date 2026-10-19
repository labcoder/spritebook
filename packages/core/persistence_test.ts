import { fileURLToPath } from 'node:url';
import { runProcess } from '../../tools/testing/process.ts';
import { append } from './fixtures/state.ts';
import { rejects } from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { pickResult, setIdentity, setRigState } from './dist/receipts.js';
import { sha256Bytes } from './dist/cache.js';
import { createWorkspace, readWorkspace, workspacePaths } from './dist/workspace.js';
import { moveManifestCursor, workspaceJob } from './dist/persistence.js';


function child(workspace: string, mode: string) {
  return runProcess(process.execPath, [
    fileURLToPath(new URL('./fixtures/persistence-worker.ts', import.meta.url)), workspace, mode,
  ]);
}

async function fixture() {
  const workspace = await fs.mkdtemp(join(tmpdir(), 'sb-state-'));
  await createWorkspace({
    workspace,
    characterId: 'state',
    displayName: 'State',
    source: { kind: 'mesh', originalFilename: 'test.glb', sha256: 'a'.repeat(64) },
  });
  return workspace;
}

const A = new Uint8Array([1, 2, 3, 4]), B = new Uint8Array([5, 6, 7, 8]);
async function assetFixture() {
  const workspace = await fixture();
  await fs.writeFile(`${workspace}/a.glb`, A);
  await fs.writeFile(`${workspace}/b.glb`, B);
  await append(workspace, 'r1', await sha256Bytes(A));
  await append(workspace, 'r2', await sha256Bytes(B));
  await pickResult(workspace, 'r1', {
    heightM: 1.7,
    texturedBy: 'backend',
    canonicalSource: `${workspace}/a.glb`,
  });
  return workspace;
}

test('undo/redo restores selected and transformed mesh bytes, including the first pick', async () => {
  const workspace = await assetFixture();
  try {
    const paths = workspacePaths(workspace);
    await pickResult(workspace, 'r2', { canonicalSource: `${workspace}/b.glb` });
    const C = new Uint8Array([9, 10, 11, 12]), D = new Uint8Array([13, 14, 15, 16]);
    await fs.writeFile(`${workspace}/rig.glb`, C);
    await setRigState(workspace, {
      track: 'A',
      skeletonProfile: 'ual-humanoid',
      jointCount: 4,
      jointEdits: [],
      orientationFixes: [],
      accepted: false,
    }, {
      canonicalMesh: { gltfSha256: await sha256Bytes(C) },
      canonicalSource: `${workspace}/rig.glb`,
    });
    await fs.writeFile(`${workspace}/identity.glb`, D);
    await setIdentity(workspace, {
      detailLayers: [{ id: 'ink', uvDecalPng: 'ink.png' }],
      canonicalMesh: { gltfSha256: await sha256Bytes(D) },
    }, { canonicalSource: `${workspace}/identity.glb` });
    for (const bytes of [C, B, A]) {
      await moveManifestCursor(paths.manifest, 'undo');
      assertEquals(new Uint8Array(await fs.readFile(paths.canonicalModel)), bytes);
      assertEquals(
        (await readWorkspace(workspace)).canonicalMesh?.gltfSha256,
        await sha256Bytes(bytes),
      );
    }
    await moveManifestCursor(paths.manifest, 'undo');
    assertEquals((await readWorkspace(workspace)).canonicalMesh, undefined);
    await rejects(() => fs.stat(paths.canonicalModel), { code: 'ENOENT' });
    for (const bytes of [A, B, C, D]) {
      await moveManifestCursor(paths.manifest, 'redo');
      assertEquals(new Uint8Array(await fs.readFile(paths.canonicalModel)), bytes);
    }
    const manifest = await fs.readFile(paths.manifest, 'utf8');
    await assertRejects(() => pickResult(workspace, 'r1', { canonicalSource: `${workspace}/b.glb` }),
      Error,
      'hash mismatch',);
    assertEquals(
      await fs.readFile(paths.manifest, 'utf8'),
      manifest,
      'failed promotion cannot replace the accepted asset',
    );
    assertEquals(new Uint8Array(await fs.readFile(paths.canonicalModel)), D);
  } finally {
    await fs.rm(workspace, { recursive: true });
  }
});

test('process death during asset publication recovers matching bytes and history', async (t) => {
  for (
    const boundary of [
      'before-intent',
      'pending.json',
      'model.glb',
      'journal.ndjson',
      'journal.cursor',
      'character.json',
    ]
  ) {
    await t.test(boundary, async () => {
      const workspace = await assetFixture();
      try {
        const result = await child(workspace, `asset:${boundary}`);
        assertEquals(result.code, 91, new TextDecoder().decode(result.stderr));
        const paths = workspacePaths(workspace);
        const state = await readWorkspace(workspace);
        const expected = boundary === 'before-intent' ? A : B;
        assertEquals(state.canonicalMesh?.gltfSha256, await sha256Bytes(expected));
        assertEquals(new Uint8Array(await fs.readFile(paths.canonicalModel)), expected);
        if (boundary !== 'before-intent') {
          await moveManifestCursor(paths.manifest, 'undo');
          assertEquals(new Uint8Array(await fs.readFile(paths.canonicalModel)), A);
          await moveManifestCursor(paths.manifest, 'redo');
          assertEquals(new Uint8Array(await fs.readFile(paths.canonicalModel)), B);
        }
      } finally {
        await fs.rm(workspace, { recursive: true });
      }
    });
  }
});

test('independent writers keep both acknowledged histories, including their inverses', async () => {
  const workspace = await fixture();
  try {
    const results = await Promise.all([child(workspace, 'writer-a'), child(workspace, 'writer-b')]);
    for (const result of results) {
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    }
    const manifest = workspacePaths(workspace).manifest;
    const ids = (await readWorkspace(workspace)).generation.results.map((r) => r.id);
    assertEquals(ids.length, 10);
    assertEquals(new Set(ids).size, 10);
    for (let i = 0; i < 10; i++) await moveManifestCursor(manifest, 'undo');
    assertEquals((await readWorkspace(workspace)).generation.results, []);
    for (let i = 0; i < 10; i++) await moveManifestCursor(manifest, 'redo');
    assertEquals((await readWorkspace(workspace)).generation.results.map((r) => r.id), ids);
  } finally {
    await fs.rm(workspace, { recursive: true });
  }
});

test('job ownership spans computation, permits reads, and releases on early return', async () => {
  const workspace = await fixture();
  try {
    const work = async function* () {
      const before = await readWorkspace(workspace);
      yield {
        t: 'started' as const,
        jobId: 'owner' as import('@spritebook/schema').JobId,
        at: '2026-10-19T00:00:00Z',
      };
      await append(workspace, `r${before.generation.results.length + 1}`);
    };
    const first = workspaceJob(workspace, work)[Symbol.asyncIterator]();
    await first.next();
    assertEquals(
      (await readWorkspace(workspace)).generation.results.length,
      0,
      'reads stay available while a job computes',
    );
    const second = (async () => {
      for await (const _ of workspaceJob(workspace, work)) { /* drain */ }
    })();
    await first.next();
    await second;
    assertEquals((await readWorkspace(workspace)).generation.results.map((r) => r.id), [
      'r1',
      'r2',
    ]);
    const canceled = workspaceJob(workspace, work)[Symbol.asyncIterator]();
    await canceled.next();
    await canceled.return?.();
    await append(workspace, 'after-cancel');
    assertEquals((await readWorkspace(workspace)).generation.results.map((r) => r.id), [
      'r1',
      'r2',
      'after-cancel',
    ]);
  } finally {
    await fs.rm(workspace, { recursive: true });
  }
});

test('process death at each persistence boundary recovers one coherent state', async (t) => {
  for (
    const boundary of [
      'before-intent',
      'pending.json',
      'journal.ndjson',
      'journal.cursor',
      'character.json',
    ]
  ) {
    await t.test(boundary, async () => {
      const workspace = await fixture();
      try {
        const result = await child(workspace, boundary);
        assertEquals(result.code, 91, new TextDecoder().decode(result.stderr));
        const manifest = workspacePaths(workspace).manifest;
        const state = await readWorkspace(workspace); // also proves the dead process released its lock
        if (boundary === 'before-intent') {
          assertEquals(state.generation.results, []);
          assertEquals(await fs.readFile(`${manifest}.journal.cursor`, 'utf8'), '0');
        } else {
          assertEquals(state.generation.results.map((r) => r.id), ['new']);
          await moveManifestCursor(manifest, 'undo');
          assertEquals((await readWorkspace(workspace)).generation.results, []);
          await moveManifestCursor(manifest, 'redo');
          assertEquals((await readWorkspace(workspace)).generation.results.map((r) => r.id), [
            'new',
          ]);
        }
        assert(
          !(await fs.readdir(workspace, { withFileTypes: true })).some((e) =>
            e.name.endsWith('.pending.json')
          ),
        );
      } finally {
        await fs.rm(workspace, { recursive: true });
      }
    });
  }
});
