import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPORTERS, runExportJob } from './dist/mod.js';

const BAKE = fileURLToPath(new URL('./fixtures/bake-aabbccdd/', import.meta.url));
const fixture = async () => JSON.parse(await fs.readFile(join(BAKE, 'manifest.json'), 'utf8'));

test('all formatters refuse portable path escapes before creating output', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-export-paths-'));
  try {
    const outside = join(root, 'victim.txt');
    await fs.writeFile(outside, 'keep this file');
    for (
      const name of [
        '../victim.txt',
        '..\\victim.txt',
        '/victim.png',
        'C:/victim.png',
        'C:\\victim.png',
        '\\\\server\\share\\victim.png',
        'folder/../victim.png',
        'folder/./image.png',
        'folder//image.png',
        'image.png:stream',
        'image\0.png',
        'payload.gd',
        'image.png.',
      ]
    ) {
      const manifest = await fixture();
      manifest.atlases.find((page: { pass: string }) => page.pass === 'lit').png = name;
      for (const [target, exporter] of Object.entries(EXPORTERS)) {
        const out = join(root, target);
        await assert.rejects(
          exporter(manifest, BAKE, out, { fps: 8 }),
          /Unsafe export artifact path/,
        );
        assert.equal(await fs.stat(out).then(() => true).catch(() => false), false);
      }
    }
    assert.equal(await fs.readFile(outside, 'utf8'), 'keep this file');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('linked atlas directories and export destinations cannot escape the chosen roots', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-export-links-'));
  try {
    const bake = join(root, 'bake'), outside = join(root, 'outside'), out = join(root, 'export');
    await fs.mkdir(bake);
    await fs.mkdir(outside);
    await fs.mkdir(out);
    await fs.copyFile(join(BAKE, 'atlas_lit_0.png'), join(outside, 'atlas_lit_0.png'));
    await fs.writeFile(join(outside, 'keep.txt'), 'user data');
    await fs.symlink(
      outside,
      join(bake, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const manifest = await fixture();
    manifest.atlases.find((page: { pass: string }) => page.pass === 'lit').png =
      'linked/atlas_lit_0.png';
    for (const exporter of Object.values(EXPORTERS)) {
      await assert.rejects(exporter(manifest, bake, join(root, 'new'), { fps: 8 }), /regular file/);
    }
    await fs.symlink(
      outside,
      join(out, 'godot'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const events = await Array.fromAsync(runExportJob({
      jobId: 'linked-output',
      bakeDir: BAKE,
      outDir: out,
      targets: ['godot'],
    }));
    assert.equal(events.at(-1)?.t, 'error');
    assert.deepEqual((await fs.readdir(outside)).sort(), ['atlas_lit_0.png', 'keep.txt']);
    assert.equal(await fs.readFile(join(outside, 'keep.txt'), 'utf8'), 'user data');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
