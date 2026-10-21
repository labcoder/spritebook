import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import {
  acquireFileLock,
  modelRuntime,
  readModelRuntime,
  runtimeDataDir,
  sidecarEnvironmentDir,
} from '@spritebook/core';
import { canonicalJson, type JobEvent, type ModelCatalog } from '@spritebook/schema';
import {
  detectPlatform,
  gateLicense,
  gatePlatform,
  gateRuntimePlatform,
  gateTerritory,
} from './gates.ts';
import { type Fetcher, fetchToFile } from './install.ts';
import { hashFile } from './hash.ts';
import { compareVersions, resolveInstalled } from './installed.ts';
import { downloadFile } from './download.ts';

async function* run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  jobId: JobEvent['jobId'],
  step: string,
): AsyncIterable<JobEvent> {
  const child = spawn(command, args, {
    env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const closed = once(child, 'close');
  void closed.catch(() => {});
  const lines = createInterface({ input: child.stderr });
  let tail = '';
  try {
    for await (const line of lines) {
      tail = (tail + line + '\n').slice(-16_384);
      if (line.trim()) {
        yield {
          t: 'progress',
          jobId,
          at: new Date().toISOString(),
          step: `${step}:${line.trim()}`,
          done: 0,
          total: 1,
        };
      }
    }
    const [code] = await closed;
    if (code !== 0) throw new Error(`Model runtime setup failed (${code}): ${tail}`);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}

/** Publish verified sources, install only frozen wheels, then admit the native stack. */
export async function* prepareModelRuntime(
  id: string,
  jobId: JobEvent['jobId'],
  opts: { sidecarDir?: string; fetcher?: Fetcher } = {},
): AsyncIterable<JobEvent> {
  const info = await modelRuntime(id, opts.sidecarDir);
  const gate = gateRuntimePlatform(info.recipe.platform);
  if (!gate.ok) throw Object.assign(new Error(gate.message), { code: gate.code, retryable: false });
  await fs.mkdir(runtimeDataDir(), { recursive: true });
  const lock = await acquireFileLock(`${info.root}.lock`);
  let stage: string | undefined;
  const at = () => new Date().toISOString();
  try {
    const ready = await readModelRuntime(info).catch(() => undefined);
    const uv = process.env.SPRITEBOOK_UV_BIN ?? 'uv';
    const env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      UV_PYTHON_PREFERENCE: 'only-managed',
      TRITON_CACHE_DIR: process.env.TRITON_CACHE_DIR ?? join(runtimeDataDir(), 'triton-cache'),
    };
    if (!ready) {
      stage = await fs.mkdtemp(`${info.root}.staging-`);
      await fs.mkdir(join(stage, 'downloads'));
      for (const [i, file] of info.recipe.sources.entries()) {
        const path = join(stage, 'downloads', String(i));
        yield* downloadFile(
          opts.fetcher ?? fetchToFile,
          file.url,
          path,
          file.bytes,
          jobId,
          `setup:download-bytes:${file.path}`,
        );
        if ((await fs.stat(path)).size !== file.bytes || await hashFile(path) !== file.sha256) {
          throw new Error(`Model runtime source hash/size mismatch: ${file.url}`);
        }
        yield {
          t: 'progress',
          jobId,
          at: at(),
          step: `setup:source:${file.path}`,
          done: i + 1,
          total: info.recipe.sources.length,
        };
      }
      yield { t: 'progress', jobId, at: at(), step: 'setup:extract', done: 0, total: 1 };
      yield* run(
        uv,
        [
          'run',
          '--no-project',
          '--python',
          '3.11.16',
          join(info.sidecarDir, 'runtimes/unpack.py'),
          info.recipePath,
          stage,
        ],
        env,
        jobId,
        'setup:extract',
      );
      // Only an app-owned, fingerprinted directory is replaced; installed weights live elsewhere.
      await fs.rm(info.root, { recursive: true, force: true });
      await fs.rename(stage, info.root);
      stage = undefined;
    }
    await fs.rm(join(info.root, 'ready.json'), { force: true });
    yield { t: 'progress', jobId, at: at(), step: 'setup:dependencies', done: 0, total: 1 };
    yield* run(
      uv,
      [
        'sync',
        '--frozen',
        '--reinstall',
        '--no-build',
        '--no-editable',
        '--no-install-project',
        '--project',
        info.project,
        ...(info.recipe.extra ? ['--extra', info.recipe.extra] : []),
      ],
      { ...env, UV_PROJECT_ENVIRONMENT: info.environment },
      jobId,
      'setup:dependencies',
    );
    // Prepare our own non-editable package while setup still has network access.
    yield { t: 'progress', jobId, at: at(), step: 'setup:sidecar', done: 0, total: 1 };
    yield* run(
      uv,
      [
        'run',
        '--frozen',
        '--no-editable',
        '--project',
        info.sidecarDir,
        'python',
        '-c',
        'import spritebook_sidecar',
      ],
      {
        ...env,
        PYTHONPATH: '',
        UV_PROJECT_ENVIRONMENT: await sidecarEnvironmentDir(info.sidecarDir),
      },
      jobId,
      'setup:sidecar',
    );
    const python = join(info.environment, 'Scripts/python.exe');
    const bindings = Object.fromEntries(
      Object.entries(info.recipe.environment).map(([key, path]) => [key, join(info.root, path)]),
    );
    yield { t: 'progress', jobId, at: at(), step: 'setup:check', done: 0, total: 1 };
    yield* run(
      python,
      [join(info.sidecarDir, info.recipe.check)],
      {
        ...env,
        ...bindings,
        PYTHONPATH: '',
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
      },
      jobId,
      'setup:check',
    );
    const files: Record<string, string> = ready?.files ?? {};
    async function record(dir: string): Promise<void> {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (item.name === '.venv' || item.name === '__pycache__') continue;
        const path = join(dir, item.name);
        if (item.isDirectory()) await record(path);
        else if (item.isFile()) {
          files[relative(info.root, path).replaceAll('\\', '/')] = await hashFile(path);
        } else throw new Error(`Unexpected model source entry: ${path}`);
      }
    }
    if (!ready) await record(info.root);
    await fs.writeFile(
      join(info.root, 'ready.json'),
      canonicalJson({ fingerprint: info.fingerprint, preparedAt: at(), files }),
    );
    yield {
      t: 'artifact',
      jobId,
      at: at(),
      kind: 'model-runtime-receipt',
      path: join(info.root, 'ready.json'),
    };
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
    await lock.close();
  }
}

export async function* runSetupJob(opts: {
  jobId: JobEvent['jobId'];
  catalog: ModelCatalog;
  root: string;
  modelId: string;
  version?: string;
  acceptLicense?: boolean;
  territory?: string;
}): AsyncIterable<JobEvent> {
  const { jobId } = opts;
  const at = () => new Date().toISOString();
  const start = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };
  try {
    const installed = await resolveInstalled(opts.root, opts.modelId, opts.version);
    if (!installed) throw new Error(`Install ${opts.modelId} weights with models install first.`);
    const entry = opts.catalog.models.find((m) => m.id === opts.modelId);
    const version = entry?.versions.find((v) => v.version === installed.version);
    if (!entry || !version) throw new Error('Installed model version is absent from the catalog');
    const platform = await detectPlatform();
    for (
      const gate of [
        gateLicense(entry, { acceptLicense: opts.acceptLicense ?? false }),
        gateTerritory(entry, { territory: opts.territory ?? installed.receipt.territoryDeclared }),
        gatePlatform(version, platform),
      ]
    ) {
      if (!gate.ok) {
        throw Object.assign(new Error(gate.message), { code: gate.code, retryable: false });
      }
    }
    if (!version.runtime && entry.versions.some((v) => v.runtime)) {
      const current = entry.versions.filter((v) => v.runtime && gatePlatform(v, platform).ok)
        .sort((a, b) => compareVersions(a.version, b.version)).at(-1);
      throw Object.assign(
        new Error(
          `${entry.id}@${version.version} is a historical weights-only version with no managed runtime. ` +
            (current
              ? `Install the complete version with spritebook models install ${entry.id}@${current.version}.`
              : 'Choose a supported managed version from spritebook models list, or configure its runtime manually.'),
        ),
        { code: 'runtime-unmanaged', retryable: false },
      );
    }
    if (version.runtime) yield* prepareModelRuntime(version.runtime, jobId);
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - start) / 1000 };
  } catch (error) {
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: (error as { code?: string }).code ?? 'model-setup-failed',
      message: `${
        error instanceof Error ? error.message : error
      } Run spritebook models setup ${opts.modelId}${
        opts.acceptLicense ? ' --accept-license' : ''
      } after correcting the problem.`,
      retryable: (error as { retryable?: boolean }).retryable ?? true,
    };
  }
}
