import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { acquireFileLock, resourcePath, runtimeDataDir } from '@spritebook/core';
import {
  canonicalJson,
  type JobEvent,
  ToolCatalogSchema,
  type ToolEntry,
  type ToolReceipt,
  ToolReceiptSchema,
} from '@spritebook/schema';
import { downloadFile } from './download.ts';
import { type Fetcher, fetchToFile } from './install.ts';
import { hashFile } from './hash.ts';
import { availableDiskBytes } from './resources.ts';

const execute = promisify(execFile);
export const defaultToolsRoot = () => join(dirname(runtimeDataDir()), 'tools');
const selection = (root: string) => join(root, 'blender.json');
const STAGE_OWNER = '.spritebook-stage.json';
const at = () => new Date().toISOString();
const failure = (code: string, message: string, retryable = false) =>
  Object.assign(new Error(message), { code, retryable });

export async function loadTools(): Promise<ToolEntry[]> {
  return ToolCatalogSchema.parse(
    JSON.parse(await fs.readFile(resourcePath('registry', 'catalog/tools.json'), 'utf8')),
  ).tools;
}

function managedDir(root: string, version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Blender version');
  return resolve(root, 'blender', version);
}

async function readReceipt(path: string): Promise<ToolReceipt | null> {
  const text = await fs.readFile(path, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  return text === null ? null : ToolReceiptSchema.parse(JSON.parse(text));
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function removeOwnedStage(root: string, path: string): Promise<void> {
  const info = await fs.lstat(path);
  if (
    !info.isDirectory() || info.isSymbolicLink() ||
    !inside(await fs.realpath(root), await fs.realpath(path))
  ) return;
  let owner;
  try {
    owner = JSON.parse(await fs.readFile(join(path, STAGE_OWNER), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return;
    throw error;
  }
  if (
    !owner || owner.tool !== 'blender' || owner.root !== await fs.realpath(root) ||
    owner.stage !== path
  ) return;
  await fs.rm(path, { recursive: true });
}

async function managedReceipt(root: string, version: string) {
  const dir = managedDir(root, version);
  const info = await readReceipt(join(dir, 'receipt.json'));
  if (
    info &&
    (info.mode !== 'managed' || info.version !== version ||
      !inside(join(dir, 'app'), info.executable))
  ) {
    throw failure('tool-receipt-invalid', `Invalid managed Blender receipt: ${dir}`);
  }
  return info as Extract<ToolReceipt, { mode: 'managed' }> | null;
}

async function selectedTool(root: string) {
  const info = await readReceipt(selection(root));
  if (info && !isAbsolute(info.executable)) {
    throw failure('tool-receipt-invalid', 'Blender receipt has a relative executable path.');
  }
  if (info?.mode === 'managed') {
    const installed = await managedReceipt(root, info.version);
    if (!installed || canonicalJson(installed) !== canonicalJson(info)) {
      throw failure(
        'tool-receipt-invalid',
        'Blender selection differs from its managed install receipt.',
      );
    }
  }
  return info;
}

/** A selected program is checked explicitly; discovery never executes it. */
export async function probeBlender(executable: string): Promise<string> {
  if (!isAbsolute(executable) || !(await fs.stat(executable)).isFile()) {
    throw failure('tool-path-invalid', 'Choose an absolute path to the Blender executable.');
  }
  const scratch = await fs.mkdtemp(join(tmpdir(), 'spritebook-blender-probe-'));
  try {
    const expression = [
      'import bpy,json',
      'm=bpy.data.meshes.new("probe")',
      'o=bpy.data.objects.new("probe",m)',
      'o.modifiers.new("cloth","CLOTH")',
      'o.modifiers.new("armature","ARMATURE")',
      'assert hasattr(bpy.ops.import_scene,"gltf") and hasattr(bpy.ops.export_scene,"gltf")',
      'print("SPRITEBOOK_PROBE="+json.dumps({"version":list(bpy.app.version)}))',
    ].join(';');
    const result = await execute(executable, [
      '--background',
      '--factory-startup',
      '--disable-autoexec',
      '--offline-mode',
      '--python-exit-code',
      '1',
      '--python-expr',
      expression,
    ], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 65_536,
      cwd: scratch,
      env: {
        ...process.env,
        BLENDER_USER_CONFIG: join(scratch, 'config'),
        BLENDER_USER_SCRIPTS: join(scratch, 'scripts'),
        BLENDER_USER_DATAFILES: join(scratch, 'data'),
        BLENDER_USER_EXTENSIONS: join(scratch, 'extensions'),
        TEMP: scratch,
        TMP: scratch,
        PYTHONPATH: '',
        PYTHONNOUSERSITE: '1',
      },
    });
    const line = result.stdout.split(/\r?\n/).find((line) => line.startsWith('SPRITEBOOK_PROBE='));
    const version: unknown = line
      ? JSON.parse(line.slice('SPRITEBOOK_PROBE='.length)).version
      : null;
    if (
      !Array.isArray(version) || version.length !== 3 || version.some((n) => !Number.isInteger(n))
    ) {
      throw failure('tool-probe-failed', 'Blender did not return a valid capability probe.');
    }
    if (version[0] !== 4 || version[1] !== 5 || version[2] < 0) {
      throw failure(
        'tool-version-unsupported',
        'Choose Blender 4.5 LTS. Other versions have not been qualified for this adapter.',
      );
    }
    return version.join('.');
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

export async function discoverBlender(): Promise<string[]> {
  const paths = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean).map((dir) =>
      join(dir, process.platform === 'win32' ? 'blender.exe' : 'blender')
    );
  if (process.platform === 'win32' && process.env.ProgramFiles) {
    paths.push(join(process.env.ProgramFiles, 'Blender Foundation', 'Blender 4.5', 'blender.exe'));
  }
  if (process.platform === 'darwin') paths.push('/Applications/Blender.app/Contents/MacOS/Blender');
  const found: string[] = [];
  for (const path of [...new Set(paths.map((path) => resolve(path)))]) {
    if (await fs.stat(path).then((s) => s.isFile()).catch(() => false)) found.push(path);
  }
  return found;
}

export interface ListedTool extends ToolEntry {
  download: ToolEntry['downloads'][number] | null;
  selected: ToolReceipt | null;
  managed: ToolReceipt[];
  detected: string[];
  issue: string | null;
}

export async function listTools(root = defaultToolsRoot()): Promise<ListedTool[]> {
  return await Promise.all((await loadTools()).map(async (tool) => {
    const download = tool.downloads.find((d) =>
      d.os === process.platform && d.arch === process.arch
    ) ?? null;
    let selected: ToolReceipt | null = null;
    const managed: ToolReceipt[] = [];
    let issue: string | null = null;
    try {
      selected = await selectedTool(root);
      const dirs = await fs.readdir(join(root, 'blender'), { withFileTypes: true }).catch(
        (error) => {
          if (error.code !== 'ENOENT') throw error;
          return [];
        },
      );
      for (const dir of dirs) {
        if (!dir.isDirectory() || !/^\d+\.\d+\.\d+$/.test(dir.name)) continue;
        const info = await managedReceipt(root, dir.name);
        if (info) managed.push(info);
      }
      if (selected && await hashFile(selected.executable) !== selected.executableSha256) {
        throw new Error('The selected Blender executable changed. Check it again before use.');
      }
    } catch (error) {
      issue = error instanceof Error ? error.message : String(error);
    }
    return { ...tool, download, selected, managed, detected: await discoverBlender(), issue };
  }));
}

async function saveSelection(root: string, info: ToolReceipt) {
  const temp = `${selection(root)}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, canonicalJson(ToolReceiptSchema.parse(info)), { flag: 'wx' });
    await fs.rename(temp, selection(root));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function inventory(
  root: string,
): Promise<Extract<ToolReceipt, { mode: 'managed' }>['files']> {
  const files: Extract<ToolReceipt, { mode: 'managed' }>['files'] = [];
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        files.push({
          path: relative(root, path).split(sep).join('/'),
          bytes: (await fs.stat(path)).size,
          sha256: await hashFile(path),
        });
      } else {throw failure(
          'tool-archive-invalid',
          'Blender archives must contain only regular files and directories.',
        );}
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

async function extract(archive: string, destination: string) {
  const tar = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe')
    : 'tar';
  await execute(tar, ['-xf', archive, '-C', destination], {
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 65_536,
  });
}

export interface ToolJobOptions {
  action: 'install' | 'use' | 'verify' | 'rm';
  root?: string;
  version?: string;
  path?: string;
  acceptLicense?: boolean;
  from?: string;
  /** Same downloader seam as models; extraction/probing can exercise failure recovery without Blender in CI. */
  fetcher?: Fetcher;
  tool?: ToolEntry;
  probe?: typeof probeBlender;
  unpack?: typeof extract;
  diskFreeBytes?: number | null;
}

/** One owner/receipt lifecycle. External programs are unregistered, never uninstalled. */
export async function* runToolJob(opts: ToolJobOptions): AsyncIterable<JobEvent> {
  const jobId = 'extensions' as JobEvent['jobId'];
  const start = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };
  let stage: string | undefined;
  let lock: Awaited<ReturnType<typeof acquireFileLock>> | undefined;
  try {
    const root = resolve(opts.root ?? defaultToolsRoot());
    const tool = opts.tool ?? (await loadTools())[0];
    const probe = opts.probe ?? probeBlender;
    await fs.mkdir(root, { recursive: true });
    lock = await acquireFileLock(join(root, 'blender.lock'));
    let selected: ToolReceipt | null = null;
    if (opts.action === 'rm' || opts.action === 'verify') {
      try {
        selected = await selectedTool(root);
      } catch (error) {
        if (opts.action !== 'rm') throw error;
        // Forget an invalid selection without trusting its paths or deleting any installation.
        if (!opts.version) {
          await fs.rm(selection(root), { force: true });
          yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - start) / 1000 };
          return;
        }
      }
    }
    if (opts.action === 'rm') {
      const version = opts.version ?? (selected?.mode === 'managed' ? selected.version : undefined);
      if (version) {
        const dir = managedDir(root, version);
        const info = await managedReceipt(root, version);
        if (!info) {
          throw failure('tool-not-installed', `No managed Blender ${version} receipt exists.`);
        }
        // Check the resolved target before recursive removal; a junction must never redirect deletion.
        if (
          !(await fs.lstat(dir)).isDirectory() ||
          !inside(await fs.realpath(root), await fs.realpath(dir))
        ) {
          throw failure(
            'tool-path-invalid',
            'Managed Blender directory is outside the tools root.',
          );
        }
        await fs.rm(dir, { recursive: true });
        if (selected?.mode === 'managed' && selected.version === version) {
          await fs.rm(selection(root));
        }
      } else {
        await fs.rm(selection(root), { force: true });
      }
    } else if (opts.action === 'verify') {
      const info = opts.version ? await managedReceipt(root, opts.version) : selected;
      if (!info) throw failure('tool-not-installed', 'Choose or download Blender first.');
      const files = info.mode === 'managed' ? info.files : [];
      const dir = info.mode === 'managed' ? join(managedDir(root, info.version), 'app') : '';
      for (const [i, file] of files.entries()) {
        const path = join(dir, file.path);
        if ((await fs.stat(path)).size !== file.bytes || await hashFile(path) !== file.sha256) {
          throw failure('tool-verify-failed', `Blender file changed: ${file.path}`);
        }
        yield { t: 'progress', jobId, at: at(), step: 'verify', done: i + 1, total: files.length };
      }
      yield { t: 'progress', jobId, at: at(), step: 'tool:check', done: 0, total: 1 };
      if (
        await hashFile(info.executable) !== info.executableSha256 ||
        await probe(info.executable) !== info.version
      ) {
        throw failure(
          'tool-verify-failed',
          'Blender changed. Select it again or remove and download the managed copy.',
        );
      }
    } else {
      if (!opts.acceptLicense) {
        throw failure(
          'license-acceptance-required',
          'Review Blender’s GPL license and pass --accept-license.',
        );
      }
      let info: ToolReceipt;
      if (opts.action === 'use') {
        yield { t: 'progress', jobId, at: at(), step: 'tool:check', done: 0, total: 1 };
        if (opts.path) {
          const executable = resolve(opts.path);
          const version = await probe(executable);
          info = {
            schemaVersion: 1,
            id: 'blender',
            mode: 'external',
            version,
            executable,
            executableSha256: await hashFile(executable),
            licenseAccepted: true,
          };
        } else {
          const existing = await managedReceipt(root, opts.version ?? tool.version);
          if (!existing) {
            throw failure(
              'tool-not-installed',
              'Pass --path to an existing Blender executable, or download Blender first.',
            );
          }
          if (
            await hashFile(existing.executable) !== existing.executableSha256 ||
            await probe(existing.executable) !== existing.version
          ) {
            throw failure('tool-verify-failed', 'The managed Blender executable changed.');
          }
          info = existing;
        }
      } else {
        if (opts.version && opts.version !== tool.version) {
          throw failure(
            'unknown-version',
            'Only the catalog’s pinned Blender download is available.',
          );
        }
        const download = tool.downloads.find((d) =>
          d.os === process.platform && d.arch === process.arch
        );
        if (!download) {
          throw failure(
            'platform-unsupported',
            'Managed Blender downloads are currently qualified on Windows x64 only. Choose an existing Blender 4.5 LTS executable.',
          );
        }
        const target = managedDir(root, tool.version);
        const parent = dirname(target);
        await fs.mkdir(parent, { recursive: true });
        if (
          (await fs.lstat(parent)).isSymbolicLink() ||
          !inside(await fs.realpath(root), await fs.realpath(parent))
        ) {
          throw failure(
            'tool-path-invalid',
            'Managed Blender directory must stay inside the tools root.',
          );
        }
        // The exclusive tool lock means marked stages have no remaining installer owner.
        for (const entry of await fs.readdir(parent)) {
          if (entry.startsWith('.staging-')) await removeOwnedStage(root, join(parent, entry));
        }
        if (
          await fs.lstat(target).then(() => true).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
            return false;
          })
        ) {
          throw failure(
            'already-installed',
            `Blender ${tool.version} already has a directory. Select it with extensions use blender@${tool.version}, or remove it first.`,
          );
        }
        const free = opts.diskFreeBytes === undefined
          ? await availableDiskBytes(root)
          : opts.diskFreeBytes;
        if (free !== null && free < download.requiredDiskBytes) {
          throw failure(
            'disk-insufficient',
            `Blender needs at least ${download.requiredDiskBytes} free bytes for download and extraction; ${free} available.`,
            true,
          );
        }
        if (free === null) {
          yield {
            t: 'warn',
            jobId,
            at: at(),
            code: 'disk-unmeasured',
            message: 'Could not measure free disk space for Blender.',
          };
        }
        stage = await fs.mkdtemp(join(parent, '.staging-'));
        await fs.writeFile(
          join(stage, STAGE_OWNER),
          canonicalJson({ tool: 'blender', root: await fs.realpath(root), stage }),
        );
        const archive = join(stage, download.archive.path);
        yield* downloadFile(
          opts.fetcher ?? (opts.from
            ? async (_url, dest) => {
              await fs.copyFile(opts.from!, dest);
            }
            : fetchToFile),
          download.archive.url,
          archive,
          download.archive.bytes,
          jobId,
          `download-bytes:${download.archive.path}`,
        );
        if (
          (await fs.stat(archive)).size !== download.archive.bytes ||
          await hashFile(archive) !== download.archive.sha256
        ) throw failure('hash-mismatch', 'Blender archive does not match its catalog pin.');
        yield { t: 'progress', jobId, at: at(), step: 'tool:extract', done: 0, total: 1 };
        await (opts.unpack ?? extract)(archive, stage);
        await fs.rename(join(stage, download.prefix), join(stage, 'app'));
        await fs.rm(archive);
        const executable = join(stage, 'app', download.executable);
        if (await hashFile(executable) !== download.executableSha256) {
          throw failure('hash-mismatch', 'Blender executable does not match its catalog pin.');
        }
        yield { t: 'progress', jobId, at: at(), step: 'tool:check', done: 0, total: 1 };
        if (await probe(executable) !== tool.version) {
          throw failure(
            'tool-version-unsupported',
            'Blender’s version differs from the catalog pin.',
          );
        }
        const files = await inventory(join(stage, 'app'));
        info = {
          schemaVersion: 1,
          id: 'blender',
          version: tool.version,
          mode: 'managed',
          executable: join(target, 'app', download.executable),
          executableSha256: download.executableSha256,
          archiveSha256: download.archive.sha256,
          licenseAccepted: true,
          files,
        };
        await fs.writeFile(
          join(stage, 'receipt.json'),
          canonicalJson(ToolReceiptSchema.parse(info)),
        );
        await fs.rename(stage, target);
        stage = undefined;
      }
      await saveSelection(root, info);
      yield { t: 'artifact', jobId, at: at(), kind: 'tool-selection', path: selection(root) };
    }
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - start) / 1000 };
  } catch (error) {
    const err = error as Error & { code?: string; retryable?: boolean };
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: typeof err.code === 'string' ? err.code : 'tool-failed',
      message: err.message ?? String(error),
      retryable: err.retryable ?? false,
    };
  } finally {
    try {
      if (stage) await removeOwnedStage(resolve(opts.root ?? defaultToolsRoot()), stage);
    } finally {
      await lock?.close();
    }
  }
}
