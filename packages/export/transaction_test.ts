import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runExportJob } from './dist/mod.js';
import type { ExportTargetId } from '@spritebook/schema';
import { acquireFileLock } from '@spritebook/core';

const BAKE = fileURLToPath(new URL('./fixtures/bake-aabbccdd/', import.meta.url));
// Publication canonicalizes paths; fault injection must compare the same physical temp root.
const TEMP_ROOT = await fs.realpath(tmpdir());
const TARGETS: ExportTargetId[] = ['godot', 'aseprite', 'texturepacker', 'strips'];
const run = (outDir: string, fps = 8, bakeDir = BAKE) =>
  Array.fromAsync(runExportJob({
    jobId: 'transaction',
    bakeDir,
    outDir,
    targets: TARGETS,
    fps,
  }));

async function changedBake(root: string) {
  const dir = join(root, 'changed-bake');
  await fs.mkdir(dir);
  const manifest = JSON.parse(await fs.readFile(join(BAKE, 'manifest.json'), 'utf8'));
  for (const clip of manifest.clips ?? []) clip.fps *= 2;
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await fs.copyFile(join(BAKE, 'atlas_lit_0.png'), join(dir, 'atlas_lit_0.png'));
  return dir;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string) {
    for (const file of await fs.readdir(dir, { withFileTypes: true })) {
      const path = join(dir, file.name);
      if (file.isDirectory()) await walk(path);
      else result[path.slice(root.length)] = (await fs.readFile(path)).toString('base64');
    }
  }
  await walk(root);
  return result;
}

test('a competing output owner refuses promptly without changing the accepted export', async () => {
  const root = await fs.mkdtemp(join(TEMP_ROOT, 'spritebook-export-busy-'));
  let lock: Awaited<ReturnType<typeof acquireFileLock>> | undefined;
  try {
    const out = join(root, 'export');
    await run(out);
    const accepted = await snapshot(out);
    lock = await acquireFileLock(`${out}.spritebook-export.lock`);
    const competing = run(out);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      competing,
      new Promise<null>((resolve) => timer = setTimeout(() => resolve(null), 2000)),
    ]).finally(() => clearTimeout(timer));
    if (result === null) {
      await lock.close();
      lock = undefined;
      await competing;
      assert.fail('Export waited on a competing owner instead of reporting busy');
    }
    const last = result.at(-1);
    assert.ok(last?.t === 'error' && last.message.includes('Another export'));
    assert.deepEqual(await snapshot(out), accepted);
  } finally {
    await lock?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a copy failure in a later format preserves the complete accepted export and user files', async () => {
  const root = await fs.mkdtemp(join(TEMP_ROOT, 'spritebook-export-copy-'));
  const copy = fs.copyFile;
  try {
    const out = join(root, 'export');
    assert.equal((await run(out)).at(-1)?.t, 'done');
    await fs.writeFile(join(out, 'notes.txt'), 'outside the generated formats');
    await fs.writeFile(join(out, 'godot', 'handwritten.gd'), 'keep this too');
    const accepted = await snapshot(out);
    const changed = await changedBake(root);
    fs.copyFile = async (source, destination, mode) => {
      if (String(destination).replaceAll('\\', '/').includes('/files/texturepacker/')) {
        throw Object.assign(new Error('injected atlas copy failure'), { code: 'EIO' });
      }
      return copy(source, destination, mode);
    };
    const events = await run(out, 12, changed);
    assert.equal(events.at(-1)?.t, 'error');
    assert.equal(events.some((event) => event.t === 'artifact'), false);
    assert.deepEqual(await snapshot(out), accepted);
  } finally {
    fs.copyFile = copy;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('closing an export during staging leaves the accepted export intact', async () => {
  const root = await fs.mkdtemp(join(TEMP_ROOT, 'spritebook-export-cancel-'));
  try {
    const out = join(root, 'export');
    await run(out);
    const accepted = await snapshot(out);
    const changed = await changedBake(root);
    for await (
      const event of runExportJob({
        jobId: 'cancel',
        bakeDir: changed,
        outDir: out,
        targets: TARGETS,
      })
    ) {
      if (event.t === 'progress') break;
    }
    assert.deepEqual(await snapshot(out), accepted);
    assert.deepEqual((await fs.readdir(root)).sort(), [
      'changed-bake',
      'export',
      'export.spritebook-export.lock',
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an untrusted recovery record cannot delete or restore a sibling directory', async () => {
  const root = await fs.mkdtemp(join(TEMP_ROOT, 'spritebook-export-recovery-path-'));
  try {
    const out = join(root, 'export'), unrelated = join(root, 'user-files');
    await fs.mkdir(unrelated);
    await fs.writeFile(join(unrelated, 'keep.txt'), 'keep');
    await fs.writeFile(
      `${out}.spritebook-export.pending.json`,
      JSON.stringify({
        version: 1,
        root: out,
        stage: unrelated,
        state: 'staging',
        files: [],
      }),
    );
    assert.equal((await run(out)).at(-1)?.t, 'error');
    assert.equal(await fs.readFile(join(unrelated, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(await fs.stat(out).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a publication failure rolls back files already replaced', async () => {
  const root = await fs.mkdtemp(join(TEMP_ROOT, 'spritebook-export-publish-'));
  const rename = fs.rename;
  try {
    const out = join(root, 'export');
    await run(out);
    const accepted = await snapshot(out);
    const changed = await changedBake(root);
    let failed = false;
    fs.rename = async (source, destination) => {
      if (!failed && resolve(String(destination)) === join(out, 'godot/fixture-char.tres')) {
        failed = true;
        throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
      }
      return rename(source, destination);
    };
    const events = await run(out, 12, changed);
    assert.equal(failed, true);
    assert.equal(events.at(-1)?.t, 'error');
    assert.deepEqual(await snapshot(out), accepted);
    assert.deepEqual((await fs.readdir(root)).sort(), [
      'changed-bake',
      'export',
      'export.spritebook-export.lock',
    ]);
  } finally {
    fs.rename = rename;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a killed publication recovers the accepted bytes before a later failed retry', async () => {
  const root = await fs.mkdtemp(join(TEMP_ROOT, 'spritebook-export-death-'));
  try {
    const out = join(root, 'export');
    await run(out);
    const accepted = await snapshot(out);
    const changed = await changedBake(root);
    const module = new URL('./dist/mod.js', import.meta.url).href;
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import { promises as fs } from 'node:fs';
      import { resolve } from 'node:path';
      import { runExportJob } from ${JSON.stringify(module)};
      const rename = fs.rename;
      fs.rename = async (source, destination) => {
        await rename(source, destination);
        if (resolve(String(destination)) === ${
        JSON.stringify(join(out, 'godot/fixture-char.tres'))
      }) {
          process.exit(77);
        }
      };
      for await (const event of runExportJob({jobId:'death', bakeDir:${JSON.stringify(changed)},
        outDir:${JSON.stringify(out)}, targets:['godot','aseprite'], fps:12})) {}
    `,
    ], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(child.status, 77, child.stderr);
    assert.notDeepEqual(await snapshot(out), accepted);
    const badBake = join(root, 'bad-bake');
    await fs.mkdir(badBake);
    await fs.copyFile(join(BAKE, 'manifest.json'), join(badBake, 'manifest.json'));
    await fs.writeFile(join(badBake, 'atlas_lit_0.png'), 'not an image');
    const retry = await run(out, 20, badBake);
    assert.equal(retry.at(-1)?.t, 'error');
    assert.deepEqual(await snapshot(out), accepted);
    assert.deepEqual((await fs.readdir(root)).sort(), [
      'bad-bake',
      'changed-bake',
      'export',
      'export.spritebook-export.lock',
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
