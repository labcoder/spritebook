import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { acquireFileLock, writeAtomic } from '@spritebook/core';
import { canonicalJson } from '@spritebook/schema';
import { fileParts, isInside, regularPath } from './files.ts';

interface Intent {
  version: 1;
  root: string;
  stage: string;
  state: 'staging' | 'publishing' | 'committed' | 'restored';
  files: { path: string; previous: boolean }[];
}

const TARGETS = new Set(['godot', 'aseprite', 'texturepacker', 'strips', 'model']);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function exists(path: string) {
  return await fs.lstat(path).then(() => true).catch((error) => {
    if (missing(error)) return false;
    throw error;
  });
}

async function checkRoot(root: string) {
  const info = await fs.lstat(root).catch((error) => {
    if (missing(error)) return null;
    throw error;
  });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new Error('Export directory changed or became a link');
  }
}

/** Only a marked sibling created for this exact output root may be removed or recovered. */
async function checkStage(intent: Intent): Promise<boolean> {
  const { root, stage } = intent;
  const parent = dirname(root);
  if (
    dirname(stage) !== parent ||
    !basename(stage).startsWith(`.${basename(root)}.spritebook-export-`)
  ) throw new Error('Invalid export recovery directory');
  if (!await exists(stage)) return false;
  const info = await fs.lstat(stage);
  if (!info.isDirectory() || info.isSymbolicLink() || !isInside(parent, await fs.realpath(stage))) {
    throw new Error('Export recovery directory is not an owned local directory');
  }
  const ownerPath = await regularPath(stage, 'owner.json');
  const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  if (owner.root !== root || owner.stage !== stage) {
    throw new Error('Export recovery owner mismatch');
  }
  return true;
}

function parseIntent(text: string, root: string): Intent {
  const value = JSON.parse(text) as Intent;
  if (
    !value || value.version !== 1 || value.root !== root || typeof value.stage !== 'string' ||
    !['staging', 'publishing', 'committed', 'restored'].includes(value.state) ||
    !Array.isArray(value.files)
  ) throw new Error('Invalid export recovery record');
  const seen = new Set<string>();
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || typeof file.previous !== 'boolean') {
      throw new Error('Invalid export recovery file');
    }
    const parts = fileParts(file.path);
    if (parts.length !== 2 || !TARGETS.has(parts[0]) || seen.has(file.path.toLowerCase())) {
      throw new Error('Invalid or duplicate export recovery target');
    }
    seen.add(file.path.toLowerCase());
  }
  return value;
}

async function finish(intent: Intent, pending: string) {
  if (await checkStage(intent)) await fs.rm(intent.stage, { recursive: true });
  await fs.rm(pending, { force: true });
}

/** Backups survive each replacement, so replaying a partially completed rollback is safe. */
async function restore(intent: Intent, pending: string) {
  await checkRoot(intent.root);
  if (!await checkStage(intent)) throw new Error('Previous export backup is missing');
  for (const file of intent.files) {
    const destination = await regularPath(intent.root, file.path, true);
    if (file.previous) {
      const backup = await regularPath(join(intent.stage, 'backup'), file.path);
      const temp = join(intent.stage, 'restore', file.path);
      await fs.mkdir(dirname(temp), { recursive: true });
      await fs.copyFile(backup, temp);
      await fs.rename(temp, destination);
    } else {
      await fs.rm(destination, { force: true });
    }
  }
  intent.state = 'restored';
  await writeAtomic(pending, canonicalJson(intent));
}

/** The workspace job lease comes first; the output lease refuses competing exporters without waiting. */
export async function beginExport(outDir: string) {
  let root = resolve(outDir);
  if (root === dirname(root)) throw new Error('Choose an export folder, not a filesystem root');
  await fs.mkdir(dirname(root), { recursive: true });
  root = join(await fs.realpath(dirname(root)), basename(root));
  if (await exists(root)) {
    if (!(await fs.stat(root)).isDirectory()) {
      throw new Error('Export destination is not a directory');
    }
    root = await fs.realpath(root);
  }
  const lock = await acquireFileLock(`${root}.spritebook-export.lock`, true).catch((error) => {
    if (error.message.includes('is busy')) {
      throw new Error('Another export is using this output directory. Finish it, then retry.');
    }
    throw error;
  });
  const pending = `${root}.spritebook-export.pending.json`;
  let intent: Intent | undefined;
  try {
    if (await exists(pending)) {
      const old = parseIntent(await fs.readFile(pending, 'utf8'), root);
      if (old.state === 'publishing') await restore(old, pending);
      await finish(old, pending);
    }
    const stage = await fs.mkdtemp(join(dirname(root), `.${basename(root)}.spritebook-export-`));
    intent = { version: 1, root, stage, state: 'staging', files: [] };
    await fs.writeFile(join(stage, 'owner.json'), canonicalJson({ root, stage }));
    await fs.mkdir(join(stage, 'files'));
    await writeAtomic(pending, canonicalJson(intent));
  } catch (error) {
    if (intent) await finish(intent, pending).catch(() => {});
    await lock.close();
    throw error;
  }
  const transaction = intent;
  let warning: string | undefined;
  return {
    directory: join(transaction.stage, 'files'),
    get warning() {
      return warning;
    },
    async publish() {
      await checkRoot(root);
      const files: string[] = [];
      for (const target of await fs.readdir(this.directory, { withFileTypes: true })) {
        if (!target.isDirectory() || !TARGETS.has(target.name)) {
          throw new Error('Invalid export target');
        }
        for (
          const file of await fs.readdir(join(this.directory, target.name), { withFileTypes: true })
        ) {
          if (!file.isFile()) throw new Error('Only regular files may be published by exporters');
          const path = relative(this.directory, join(this.directory, target.name, file.name))
            .replaceAll('\\', '/');
          fileParts(path);
          files.push(path);
        }
      }
      files.sort();
      const seen = new Set<string>();
      for (const path of files) {
        if (seen.has(path.toLowerCase())) throw new Error(`Duplicate export file: ${path}`);
        seen.add(path.toLowerCase());
        const destination = await regularPath(root, path, true);
        const previous = await exists(destination);
        if (previous) {
          const backup = join(transaction.stage, 'backup', path);
          await fs.mkdir(dirname(backup), { recursive: true });
          await fs.copyFile(destination, backup);
        }
        transaction.files.push({ path, previous });
      }
      await fs.mkdir(root, { recursive: true });
      for (const path of files) await fs.mkdir(dirname(join(root, path)), { recursive: true });
      transaction.state = 'publishing';
      await writeAtomic(pending, canonicalJson(transaction));
      for (const path of files) {
        await regularPath(root, path, true);
        await fs.rename(join(this.directory, path), join(root, path));
      }
      await writeAtomic(pending, canonicalJson({ ...transaction, state: 'committed' }));
      transaction.state = 'committed';
      await finish(transaction, pending).catch((error) => {
        // The durable commit succeeded; cleanup is retried from its record on the next export.
        warning = `Export completed; backup cleanup is pending: ${error.message}`;
      });
    },
    async [Symbol.asyncDispose]() {
      try {
        if (transaction.state !== 'committed') {
          if (transaction.state === 'publishing') await restore(transaction, pending);
          await finish(transaction, pending);
        }
      } finally {
        await lock.close();
      }
    },
  };
}
