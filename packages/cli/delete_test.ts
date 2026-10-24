import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { test } from 'node:test';
import {
  acquireFileLock,
  commitManifest,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  sha256Bytes,
} from '@spritebook/core';
import { runCli } from './dist/mod.js';

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-delete-'));
  assert(resolve(root).startsWith(resolve(tmpdir())), 'only test-owned temporary workspaces');
  const workspace = join(root, 'hero');
  const source = Buffer.from('original user image');
  const hash = await sha256Bytes(source);
  await createWorkspace({
    workspace,
    characterId: 'hero',
    displayName: 'Hero',
    source: { kind: 'image', originalFilename: 'hero.png', sha256: hash },
  });
  const original = join(workspace, 'source', `${hash}.png`);
  await fs.writeFile(original, source);
  await fs.writeFile(join(root, 'hero.png'), source);
  await fs.writeFile(join(workspace, 'notes.txt'), 'user notes');
  for (
    const dir of [
      'results/r1',
      'canonical',
      'rig',
      'anim',
      'look',
      'bakes/bake-a',
      'export',
      'cache',
    ]
  ) {
    await fs.mkdir(join(workspace, dir), { recursive: true });
    await fs.writeFile(join(workspace, dir, 'generated.bin'), 'generated artifact');
  }
  return { root, workspace, original, source, hash };
}

test('confirmed deletion removes generated data and gallery entry, preserving source inputs and user files', async () => {
  const f = await fixture();
  try {
    const lines: string[] = [];
    const run = (extra: string[]) =>
      runCli(['delete', '--workspace', f.workspace, ...extra, '--json'], {
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(line),
      });
    const before = await fs.readFile(join(f.workspace, 'character.json'));
    assert.equal(await run([]), 1);
    assert.equal(await run(['--confirm', 'someone-else']), 1);
    assert.deepEqual(await fs.readFile(join(f.workspace, 'character.json')), before);
    assert.equal(
      await fs.readFile(join(f.workspace, 'results/r1/generated.bin'), 'utf8'),
      'generated artifact',
    );
    const second = Buffer.from('new original input');
    const hash = await sha256Bytes(second);
    await fs.writeFile(join(f.workspace, 'source', `${hash}.png`), second);
    await commitManifest(join(f.workspace, 'character.json'), () => ({
      op: [{ op: 'replace', path: '/source/sha256', value: hash }],
      label: 'Use another input',
    }));
    const prepared = join(f.workspace, 'source', `${'f'.repeat(64)}.png`);
    await fs.writeFile(prepared, 'generated background removal');
    await fs.writeFile(join(f.workspace, 'source', 'notes.txt'), 'source notes');
    await createWorkspace({
      workspace: join(f.root, 'other'),
      characterId: 'other',
      displayName: 'Other',
      source: { kind: 'image', originalFilename: 'other.png', sha256: 'b'.repeat(64) },
    });
    assert.equal(await run(['--confirm', 'hero']), 0);
    assert.deepEqual(await fs.readFile(f.original), f.source);
    assert.deepEqual(await fs.readFile(join(f.root, 'hero.png')), f.source);
    assert.deepEqual(await fs.readFile(join(f.workspace, 'source', `${hash}.png`)), second);
    assert.equal(await fs.readFile(join(f.workspace, 'notes.txt'), 'utf8'), 'user notes');
    assert.equal(await fs.readFile(join(f.workspace, 'source/notes.txt'), 'utf8'), 'source notes');
    for (
      const path of [
        'character.json',
        'results',
        'canonical',
        'rig',
        'anim',
        'look',
        'bakes',
        'export',
        'cache',
      ]
    ) {
      await assert.rejects(fs.stat(join(f.workspace, path)), { code: 'ENOENT' });
    }
    await assert.rejects(fs.stat(prepared), { code: 'ENOENT' });
    assert.deepEqual((await listWorkspaces(f.root)).map((w) => w.manifest?.id), ['other']);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('linked output or nested project refuses the whole deletion before removing any artifact', async () => {
  const f = await fixture();
  try {
    await assert.rejects(deleteWorkspace(parse(f.workspace).root, 'hero'), /filesystem root/);
    const outside = join(f.root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, 'keep.txt'), 'outside user data');
    const linked = join(f.workspace, 'bakes', 'linked');
    await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(deleteWorkspace(f.workspace, 'hero'), /linked output/);
    assert.equal(
      await fs.readFile(join(f.workspace, 'results/r1/generated.bin'), 'utf8'),
      'generated artifact',
    );
    assert.equal(await fs.readFile(join(outside, 'keep.txt'), 'utf8'), 'outside user data');
    await fs.unlink(linked);
    await fs.mkdir(join(f.workspace, 'rig', 'nested'));
    await fs.writeFile(join(f.workspace, 'rig/nested/character.json'), '{}');
    await assert.rejects(deleteWorkspace(f.workspace, 'hero'), /Another project/);
    assert.equal(
      await fs.readFile(join(f.workspace, 'results/r1/generated.bin'), 'utf8'),
      'generated artifact',
    );
    assert.deepEqual(await fs.readFile(f.original), f.source);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('active job refuses deletion immediately; an interrupted cleanup keeps the project record for retry', async (t) => {
  const f = await fixture();
  try {
    const lease = await acquireFileLock(join(f.workspace, 'character.json.job.lock'));
    try {
      await assert.rejects(deleteWorkspace(f.workspace, 'hero'), /project is busy/);
      assert.equal(
        await fs.readFile(join(f.workspace, 'rig/generated.bin'), 'utf8'),
        'generated artifact',
      );
    } finally {
      await lease.close();
    }
    const rm = fs.rm;
    const mock = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === join(f.workspace, 'rig')) {
        throw Object.assign(new Error('file in use'), { code: 'EBUSY' });
      }
      return rm(...args);
    });
    await assert.rejects(deleteWorkspace(f.workspace, 'hero'), /Deletion did not finish/);
    mock.mock.restore();
    assert.equal(
      JSON.parse(await fs.readFile(join(f.workspace, 'character.json'), 'utf8')).id,
      'hero',
    );
    assert.deepEqual(await fs.readFile(f.original), f.source);
    await deleteWorkspace(f.workspace, 'hero');
    assert.deepEqual(await listWorkspaces(f.root), []);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('retry after journal removal and failed manifest unlink retains every historical original', async (t) => {
  const f = await fixture();
  try {
    const second = Buffer.from('second original input');
    const secondHash = await sha256Bytes(second);
    const secondPath = join(f.workspace, 'source', `${secondHash}.png`);
    await fs.writeFile(secondPath, second);
    await commitManifest(join(f.workspace, 'character.json'), () => ({
      op: [{ op: 'replace', path: '/source/sha256', value: secondHash }],
      label: 'Replace input',
    }));
    const rm = fs.rm;
    const mock = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
      if (resolve(String(args[0])) === join(f.workspace, 'character.json')) {
        throw Object.assign(new Error('manifest is open in another program'), { code: 'EBUSY' });
      }
      return rm(...args);
    });
    await assert.rejects(deleteWorkspace(f.workspace, 'hero'), /Deletion did not finish/);
    mock.mock.restore();
    await assert.rejects(fs.stat(join(f.workspace, 'character.json.journal.ndjson')), {
      code: 'ENOENT',
    });
    const retained = JSON.parse(
      await fs.readFile(join(f.workspace, 'source/.spritebook-originals.json'), 'utf8'),
    );
    assert.deepEqual(retained.sha256.sort(), [f.hash, secondHash].sort());
    await deleteWorkspace(f.workspace, 'hero');
    assert.deepEqual(await fs.readFile(f.original), f.source);
    assert.deepEqual(await fs.readFile(secondPath), second);
    assert.deepEqual(await listWorkspaces(f.root), []);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('delete reclaims only owner-verified default export stages and respects the external-export lease', async (t) => {
  const f = await fixture();
  try {
    const output = join(f.workspace, 'export');
    const stage = join(f.workspace, '.export.spritebook-export-owned1');
    const unrelated = join(f.workspace, '.export.spritebook-export-other1');
    for (const dir of [stage, unrelated]) {
      await fs.mkdir(dir);
      await fs.writeFile(join(dir, 'backup.bin'), 'keep until ownership checked');
    }
    await fs.writeFile(join(stage, 'owner.json'), JSON.stringify({ root: output, stage }));
    await fs.writeFile(
      join(unrelated, 'owner.json'),
      JSON.stringify({ root: join(f.root, 'elsewhere'), stage: unrelated }),
    );
    const pending = `${output}.spritebook-export.pending.json`;
    await fs.writeFile(
      pending,
      JSON.stringify({ version: 1, root: output, stage, state: 'publishing', files: [] }),
    );
    const lease = await acquireFileLock(`${output}.spritebook-export.lock`);
    try {
      await assert.rejects(deleteWorkspace(f.workspace, 'hero'), /project is busy/);
      assert.equal(
        await fs.readFile(join(stage, 'backup.bin'), 'utf8'),
        'keep until ownership checked',
      );
    } finally {
      await lease.close();
    }
    const rm = fs.rm;
    const mock = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === stage) {
        throw Object.assign(new Error('stage file is in use'), { code: 'EBUSY' });
      }
      return rm(...args);
    });
    await assert.rejects(deleteWorkspace(f.workspace, 'hero'), /Deletion did not finish/);
    mock.mock.restore();
    await assert.rejects(fs.stat(pending), { code: 'ENOENT' });
    await deleteWorkspace(f.workspace, 'hero');
    await assert.rejects(fs.stat(stage), { code: 'ENOENT' });
    await assert.rejects(fs.stat(pending), { code: 'ENOENT' });
    assert.equal(
      await fs.readFile(join(unrelated, 'backup.bin'), 'utf8'),
      'keep until ownership checked',
    );
    assert.deepEqual(await fs.readFile(f.original), f.source);
    assert.equal((await fs.stat(`${output}.spritebook-export.lock`)).size, 0);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
