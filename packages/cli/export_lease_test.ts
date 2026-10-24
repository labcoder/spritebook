import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireFileLock, commitManifest, createWorkspace, workspacePaths } from '@spritebook/core';
import { runCli } from './dist/mod.js';

test('workspace export holds the character lease until staged files are published', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-export-lease-'));
  const copied = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const copy = fs.copyFile;
  let exporting: Promise<number> | undefined;
  try {
    await createWorkspace({
      workspace: root,
      characterId: 'fixture-char',
      displayName: 'Fixture',
      source: { kind: 'image', originalFilename: 'source.png', sha256: 'a'.repeat(64) },
    });
    const manifest = workspacePaths(root).manifest;
    await commitManifest(manifest, () => ({
      op: [{ op: 'add', path: '/lastBakeId', value: 'aabbccdd' }],
      label: 'Select fixture bake',
    }));
    const bake = join(root, 'bakes/bake-aabbccdd');
    await fs.cp(fileURLToPath(new URL('../export/fixtures/bake-aabbccdd', import.meta.url)), bake, {
      recursive: true,
    });
    fs.copyFile = async (source, destination, mode) => {
      if (String(destination).replaceAll('\\', '/').includes('/files/godot/')) {
        copied.resolve();
        await release.promise;
      }
      return copy(source, destination, mode);
    };
    exporting = runCli([
      'export',
      '--workspace',
      root,
      '--out',
      join(root, 'export'),
      '--targets',
      'godot',
      '--json',
    ], { stdout() {}, stderr() {} });
    await Promise.race([
      copied.promise,
      exporting.then(() => {
        throw new Error('Export stopped before copying its staged atlas');
      }),
    ]);
    await assert.rejects(acquireFileLock(`${manifest}.job.lock`, true), /busy/);
    release.resolve();
    assert.equal(await exporting, 0);
    const available = await acquireFileLock(`${manifest}.job.lock`, true);
    await available.close();
  } finally {
    release.resolve();
    await exporting;
    fs.copyFile = copy;
    await fs.rm(root, { recursive: true, force: true });
  }
});
