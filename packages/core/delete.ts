import { promises as fs } from 'node:fs';
import { dirname, parse, relative, resolve } from 'node:path';
import { CharacterIdSchema, parseWith } from '@spritebook/schema';
import { withManifestLock, withManifestWrite, writeAtomic } from './persistence.ts';
import { readWorkspace, workspacePaths } from './workspace.ts';

/** These trees belong to SpriteBook; paths in manifests never expand this list. */
const OUTPUTS = ['results', 'canonical', 'rig', 'anim', 'look', 'bakes', 'export', 'cache'];
const REPORTS = ['bone-mask', 'attachments', 'decals'].map((step) =>
  `identity-${step}-report.json`
);

async function present(path: string) {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function validateTree(path: string): Promise<void> {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Cannot delete a project containing a linked output: "${path}".`);
  }
  if (!stat.isDirectory()) return;
  for (const entry of await fs.readdir(path, { withFileTypes: true })) {
    if (entry.name.toLowerCase() === 'character.json') {
      throw new Error(`Another project is nested inside "${path}"; move it before deleting.`);
    }
    await validateTree(resolve(path, entry.name));
  }
}

/** Irreversible by explicit confirmation; keep original inputs and unrecognized user files. */
export async function deleteWorkspace(workspace: string, confirmation: string) {
  const expectedId = parseWith(CharacterIdSchema, confirmation, 'confirmed character id');
  const root = resolve(workspace);
  if (root === parse(root).root || !(await fs.lstat(root)).isDirectory()) {
    throw new Error('Choose a character workspace, not a filesystem root or linked folder.');
  }
  const real = await fs.realpath(root);
  const samePath = process.platform === 'win32'
    ? real.toLowerCase() === root.toLowerCase()
    : real === root;
  if (!samePath) throw new Error('Move the project out of linked folders before deleting it.');
  const paths = workspacePaths(root);
  const sourceDir = resolve(paths.sourceDir);
  const state = [paths.journal, paths.cursor, `${paths.manifest}.pending.json`, paths.manifest];
  for (const path of [...state, `${paths.manifest}.lock`, `${paths.manifest}.job.lock`]) {
    const stat = await present(path);
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
      throw new Error('The project record or lock is linked or invalid; no files were deleted.');
    }
  }
  // Never unlink lock files: another process may already be waiting on their inode.
  return await withManifestWrite(
    paths.manifest,
    () =>
      withManifestLock(paths.manifest, async () => {
        const manifest = await readWorkspace(root);
        if (manifest.id !== expectedId) {
          throw new Error('The project identity changed. Reopen it and confirm deletion again.');
        }
        const sourceHashes = new Set([manifest.source.sha256]);
        const journal = await fs.readFile(paths.journal, 'utf8').catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
          throw error;
        });
        // Earlier source inputs belong to the user too, including those retained for undo.
        for (const line of journal.split('\n').filter(Boolean)) {
          const patch = JSON.parse(line);
          for (const op of [...patch.op, ...patch.inverse]) {
            const hash = op.path === '/source'
              ? op.value?.sha256
              : op.path === '/source/sha256'
              ? op.value
              : undefined;
            if (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) sourceHashes.add(hash);
          }
        }
        const targets: string[] = [];
        for (const name of [...OUTPUTS, ...REPORTS]) {
          const path = resolve(root, name);
          const stat = await present(path);
          if (!stat) continue;
          if (!stat.isSymbolicLink() && stat.isDirectory() !== OUTPUTS.includes(name)) {
            throw new Error(`Unexpected project output at "${path}"; no files were deleted.`);
          }
          targets.push(path);
        }
        const preservedSource: string[] = [];
        const originalsRecord = resolve(sourceDir, '.spritebook-originals.json');
        if (await present(sourceDir)) {
          const sourceStat = await fs.lstat(sourceDir);
          if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
            throw new Error(
              'The source folder is linked or invalid; no project files were deleted.',
            );
          }
          const recordStat = await present(originalsRecord);
          if (recordStat) {
            if (
              recordStat.isSymbolicLink() || !recordStat.isFile() || recordStat.size > 1024 * 1024
            ) {
              throw new Error(
                'The retained source record is linked or invalid; no files were deleted.',
              );
            }
            const record = JSON.parse(await fs.readFile(originalsRecord, 'utf8'));
            if (
              record?.schemaVersion !== 1 || !Array.isArray(record.sha256) ||
              Object.keys(record).some((key) => !['schemaVersion', 'sha256'].includes(key)) ||
              !record.sha256.every((hash: unknown) =>
                typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)
              )
            ) throw new Error('The retained source record is invalid; no files were deleted.');
            for (const hash of record.sha256) sourceHashes.add(hash);
          }
          for (const name of await fs.readdir(sourceDir)) {
            const path = resolve(sourceDir, name);
            if (sourceHashes.has(name.split('.')[0].toLowerCase())) {
              preservedSource.push(path);
            } else if (
              /^(?:[a-f0-9]{64}(?:\.[a-z0-9]+)?|prep-[a-f0-9]{64}|preflight\.json)$/i.test(name)
            ) {
              targets.push(path);
            }
          }
        }
        for (const path of targets) {
          if (dirname(path) !== root && dirname(path) !== sourceDir) {
            throw new Error('Deletion target escaped the project.');
          }
          await validateTree(path);
        }
        // Validate the complete plan before removing anything; manifest last keeps failures retryable.
        for (const path of state) if (await present(path)) await validateTree(path);
        // A locked manifest can outlive its journal; keep every original input safe on retry.
        await fs.mkdir(sourceDir, { recursive: true });
        await writeAtomic(
          originalsRecord,
          JSON.stringify({ schemaVersion: 1, sha256: [...sourceHashes].sort() }) + '\n',
        );
        try {
          for (const path of [...targets, ...state]) {
            await fs.rm(path, { recursive: true, force: true });
          }
        } catch (error) {
          throw new Error(
            'Deletion did not finish. Some generated files may already be removed. ' +
              'The original source is preserved; close programs using this project and retry. ' +
              (error instanceof Error ? error.message : String(error)),
          );
        }
        return {
          id: manifest.id,
          workspace: root,
          preservedSource: preservedSource.map((path) => relative(root, path)),
          removed: [...targets, ...state].map((path) => relative(root, path)),
        };
      }),
    true,
  );
}
