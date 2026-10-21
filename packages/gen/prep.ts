import { promises as fs } from 'node:fs';
import { acquireVramLeaseEvents, SidecarSession, type VramLease } from '@spritebook/core';
import { adapterFor, defaultsFor, type JobEvent, preflightVram } from '@spritebook/schema';
import {
  defaultModelsRoot,
  detectVramGb,
  executionVram,
  loadCatalog,
  resolvePinnedInstalled,
  verifyExecutionModel,
  versionDir,
} from '@spritebook/registry';
import { decode } from 'fast-png';

export interface PrepJobOptions {
  jobId: string;
  imagePath: string;
  outDir: string;
  sidecarDir: string;
  modelsRoot?: string;
  catalogPath?: string;
  pinsPath?: string;
  workspace?: string;
  detectedVramGb?: number | null;
  vramLeaseDir?: string;
}

/** Already prepared RGBA passes through byte-for-byte; opaque images need matting. */
export async function isCutoutImage(path: string): Promise<boolean> {
  const bytes = new Uint8Array(await fs.readFile(path));
  try {
    const image = decode(bytes, { checkCrc: true });
    if (image.channels !== 4 || image.depth !== 8) return false;
    let background = false, subject = false;
    for (let i = 3; i < image.data.length; i += 4) {
      background ||= image.data[i]! < 255;
      subject ||= image.data[i]! > 204;
      if (background && subject) return true;
    }
  } catch { /* JPEG/WebP and other readable sources are handled by imageprep. */ }
  return false;
}

/** Shared by explicit prep and automatic generation prep; never downloads weights. */
export async function* runPrepJob(opts: PrepJobOptions): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = opts.jobId as JobEvent['jobId'];
  let session: SidecarSession | undefined;
  let lease: VramLease | undefined;
  try {
    try {
      const root = opts.modelsRoot ?? defaultModelsRoot();
      const installed = await resolvePinnedInstalled(root, 'rembg-u2net', undefined, opts);
      if (!installed) {
        throw Object.assign(
          new Error(
            'Background removal needs rembg-u2net. Install it in Manage models or run ' +
              `\`spritebook models install rembg-u2net\` (models root: ${root}).`,
          ),
          { code: 'model-missing' },
        );
      }
      const catalog = await loadCatalog(opts.catalogPath);
      const entry = catalog.models.find((m) => m.id === 'rembg-u2net');
      const version = entry?.versions.find((v) => v.version === installed.version);
      if (!entry || !version) {
        throw Object.assign(new Error('Installed image-prep version is not in the catalog'), {
          code: 'unknown-model',
        });
      }
      await verifyExecutionModel({ root, catalog, entry, version, receipt: installed.receipt });
      const params = defaultsFor(version, 'imageprep');
      const claim = executionVram(version, 'imageprep', params);
      const budget = opts.detectedVramGb !== undefined ? opts.detectedVramGb : await detectVramGb();
      const memory = preflightVram(claim, budget);
      if (!memory.ok) throw Object.assign(new Error(memory.message), { code: memory.code });
      if (memory.warn) {
        yield { t: 'warn', jobId, at: at(), code: `vram-${memory.status}`, message: memory.warn };
      }
      await fs.stat(`${opts.sidecarDir}/pyproject.toml`).catch(() => {
        throw Object.assign(new Error('Cannot find the sidecar project; pass --sidecar <dir>.'), {
          code: 'sidecar-missing',
        });
      });
      await fs.mkdir(opts.outDir, { recursive: true });
      lease = yield* acquireVramLeaseEvents({
        gb: claim ?? 0,
        budgetGb: budget,
        jobId,
        ...(opts.vramLeaseDir !== undefined ? { dir: opts.vramLeaseDir } : {}),
      }, at);
      session = new SidecarSession({ sidecarDir: opts.sidecarDir });
      for await (
        const e of session.run({
          jobId,
          kind: adapterFor(entry.id, version, 'imageprep'),
          params: {
            ...params,
            imagePath: opts.imagePath,
            outDir: opts.outDir,
            modelDir: versionDir(root, entry.id, installed.version),
          },
        })
      ) {
        if (e.t === 'done') {
          const path = `${opts.outDir}/prep-meta.json`;
          await fs.writeFile(
            path,
            JSON.stringify({
              backend: { modelId: entry.id, version: version.version },
              params,
            }) + '\n',
          );
          yield { t: 'artifact', jobId, at: at(), kind: 'prep-meta', path };
        }
        yield e;
      }
    } finally {
      try {
        await session?.dispose();
      } finally {
        await lease?.release();
      }
    }
  } catch (err) {
    const failure = err as { code?: string; retryable?: boolean };
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: failure.code ?? 'prep-failed',
      message: err instanceof Error ? err.message : String(err),
      retryable: failure.retryable ?? false,
    };
  }
}
