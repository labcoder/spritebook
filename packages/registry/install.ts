import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import { prepareModelRuntime } from './setup.ts';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { modelRuntime } from '@spritebook/core';
/**
 * Install / verify / rm jobs (D-009), speaking the runBakeJob event
 * discipline: queued -> started -> per-file progress -> artifact -> done,
 * and every failure is a schema-valid error EVENT with an actionable code —
 * never a throw across the seam.
 *
 * Install discipline: resolve from the catalog, gates first (platform,
 * license, territory — VRAM only warns; the job-time preflight is the hard
 * gate), then every file downloads into a staging dir and must match its
 * catalog sha256 AND byte count before anything lands in the final dir.
 * NOTHING lands unverified: the trust anchor is the hash, never the download
 * source (sidecar-vram skill). Verification hashes the staged file through
 * the same streaming hashFile that verify uses — one code path, and an
 * injected fetcher is never trusted to report its own hashes.
 */
import type {
  InstallReceipt,
  JobEvent,
  ModelCatalog,
  ModelEntry,
  ModelVersion,
  Platform,
} from '@spritebook/schema';
import {
  canonicalJson,
  InstallReceiptSchema,
  parseWith,
  SCHEMA_VERSION,
  versionDiskBytes,
} from '@spritebook/schema';
import {
  detectPlatform,
  detectVramGb,
  gateLicense,
  gatePlatform,
  gateRuntimePlatform,
  gateTerritory,
  gateVram,
} from './gates.ts';
import {
  compareVersions,
  getReceipt,
  listInstalled,
  RECEIPT_FILE,
  resolveInstalled,
  versionDir,
} from './installed.ts';
import {
  detectAppDataVirtualization,
  rootUnderLocalAppData,
  type VirtualizationReport,
} from './virtualization.ts';
import { hashFile, licenseFingerprint } from './hash.ts';

/** Injectable downloader: fetch `url` into `destPath`, optionally reporting bytes so far. */
export type Fetcher = (
  url: string,
  destPath: string,
  onBytes?: (bytesSoFar: number) => void,
) => Promise<void>;

/** Default fetcher: fetch() streamed straight to disk — never buffered whole. */
export const fetchToFile: Fetcher = async (url, destPath, onBytes) => {
  let current = new URL(url);
  let resp: Response;
  for (let redirects = 0;; redirects++) {
    let token: string | undefined;
    if (current.origin === 'https://huggingface.co') {
      token = process.env.HF_TOKEN?.trim();
      if (!token && !/^(?:1|on|yes|true)$/i.test(process.env.HF_HUB_DISABLE_IMPLICIT_TOKEN ?? '')) {
        const home = process.env.HF_HOME ??
          join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'huggingface');
        token = await fs.readFile(process.env.HF_TOKEN_PATH ?? join(home, 'token'), 'utf8').then((
          text,
        ) => text.trim()).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        });
      }
    }
    if (token && !/^[\x21-\x7e]+$/.test(token)) {
      throw new Error('Invalid Hugging Face token format - run hf auth login or fix HF_TOKEN');
    }
    resp = await fetch(current, {
      redirect: 'manual',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (![301, 302, 303, 307, 308].includes(resp.status)) break;
    await resp.body?.cancel();
    if (redirects >= 5) throw new Error(`GET ${url}: too many redirects`);
    const location = resp.headers.get('location');
    if (!location) throw new Error(`GET ${url}: redirect has no location`);
    const next = new URL(location, current);
    if (next.protocol !== 'https:') throw new Error(`GET ${url}: insecure redirect refused`);
    current = next;
  }
  if (!resp.ok || resp.body === null) {
    await resp.body?.cancel();
    throw new Error(
      `GET ${url} -> HTTP ${resp.status}${
        resp.status === 401 || resp.status === 403
          ? ' - request model access, then run hf auth login or set HF_TOKEN'
          : ''
      }`,
    );
  }
  let seen = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      onBytes?.(seen);
      controller.enqueue(chunk);
    },
  });
  await resp.body.pipeThrough(counter).pipeTo(Writable.toWeb(createWriteStream(destPath)));
};

/**
 * Offline fetcher: take each file from `<sourceDir>/<declared path>` instead
 * of the network. Hash verification is UNCHANGED — the bytes still have to
 * match the catalog pin — so this is a different delivery route, never a
 * weaker guarantee. Exists for air-gapped installs and for reusing bytes an
 * upstream tool already downloaded (an HF cache, a colleague's copy).
 */
export function fetchFromDir(sourceDir: string, files: { path: string; url: string }[]): Fetcher {
  const byUrl = new Map(files.map((f) => [f.url, f.path]));
  return async (url, destPath) => {
    const rel = byUrl.get(url);
    if (rel === undefined) throw new Error(`no local file mapped for ${url}`);
    const src = `${sourceDir}/${rel}`;
    try {
      await fs.copyFile(src, destPath);
    } catch {
      throw new Error(
        `cannot read "${src}" - --from expects the files laid out at their declared paths`,
      );
    }
  };
}

/** Expected failure with its event code; anything else surfaces as the job's generic code. */
class JobFail extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

export interface InstallJobOpts {
  jobId: string;
  catalog: ModelCatalog;
  /** models root (the CLI seam passes defaultModelsRoot(); explicit here) */
  root: string;
  modelId: string;
  /** omitted -> the highest catalog version (compareVersions) */
  version?: string;
  /** the user's explicit --accept-license, recorded in the receipt when required */
  acceptLicense?: boolean;
  /** the user's --territory self-declaration (D-027; never geolocated) */
  territory?: string;
  /** injectable for tests — the default downloads over the network */
  fetcher?: Fetcher;
  /** injectable detection results (tests); omitted fields run the real probes */
  detected?: {
    platform?: Platform;
    vramGb?: number | null;
    virtualization?: VirtualizationReport;
  };
}

/**
 * Install one catalog version under `<root>/<modelId>/<version>/` with a
 * receipt. Event codes: unknown-model, unknown-version, platform-unsupported,
 * license-acceptance-required, territory-declaration-required,
 * territory-excluded, territory-invalid, already-installed, download-failed
 * (retryable), hash-mismatch, install-failed; warns vram-unknown /
 * vram-below-min.
 */
export async function* runInstallJob(opts: InstallJobOpts): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = opts.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  let staging: string | undefined;
  try {
    const entry = findEntry(opts.catalog, opts.modelId);
    const version = findVersion(entry, opts.version);

    const platform = opts.detected?.platform ?? await detectPlatform();
    const gates = [
      gatePlatform(version, platform),
      gateLicense(entry, { acceptLicense: opts.acceptLicense ?? false }),
      gateTerritory(entry, { territory: opts.territory }),
    ];
    for (const gate of gates) {
      if (!gate.ok) throw new JobFail(gate.code, gate.message);
    }
    if (version.runtime) {
      const info = await modelRuntime(version.runtime).catch((error) => {
        throw new JobFail(
          'invalid-runtime',
          `Cannot read runtime recipe ${version.runtime}. Update SpriteBook or correct the catalog: ${
            message(error)
          }`,
        );
      });
      const gate = gateRuntimePlatform(info.recipe.platform);
      if (!gate.ok) throw new JobFail(gate.code, gate.message);
    }
    const vramGb = opts.detected?.vramGb !== undefined
      ? opts.detected.vramGb
      : await detectVramGb();
    const vram = gateVram(version, vramGb);
    if (vram.status === 'unknown' || vram.status === 'below-min') {
      yield { t: 'warn', jobId, at: at(), code: `vram-${vram.status}`, message: vram.warn };
    }

    // D-039: an install run inside an MSIX container lands in that package's
    // private LocalCache overlay, invisible to every unpackaged process on
    // the machine. Warn BEFORE the download - the July poisoning that led to
    // the split-brain incident would have announced itself right here.
    const virt = opts.detected?.virtualization ??
      (rootUnderLocalAppData(opts.root)
        ? await detectAppDataVirtualization()
        : { virtualized: false });
    if (virt.virtualized) {
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'models-root-virtualized',
        message: `This process runs inside the "${virt.pkg}" MSIX container: ` +
          `%LOCALAPPDATA% is virtualized, so this install lands in the container-private ` +
          `overlay and is INVISIBLE to unpackaged processes (D-039). Install from a normal ` +
          `terminal, or set SPRITEBOOK_MODELS_DIR outside AppData.`,
      };
    }

    const finalDir = versionDir(opts.root, entry.id, version.version);
    if (await getReceipt(opts.root, entry.id, version.version)) {
      throw new JobFail(
        'already-installed',
        `Model "${entry.id}" ${version.version} is already installed at ${finalDir}. ` +
          `Installs never overwrite - run \`spritebook models rm ${entry.id}\` first ` +
          `to reinstall.`,
      );
    }

    // download ALL files to staging; each must verify before finalize
    staging = `${opts.root}/.staging-${entry.id}-${version.version}-${randomHex(4)}`;
    await fs.mkdir(staging, { recursive: true });
    const fetcher = opts.fetcher ?? fetchToFile;
    const total = version.files.length;
    const verified: InstallReceipt['files'] = [];
    for (const [i, f] of version.files.entries()) {
      const dest = `${staging}/${f.path}`;
      const parent = dest.slice(0, dest.lastIndexOf('/'));
      await fs.mkdir(parent, { recursive: true });
      try {
        await fetcher(f.url, dest);
      } catch (err) {
        throw new JobFail(
          'download-failed',
          `Downloading ${f.url} failed: ${message(err)}. This is usually transient - ` +
            `retry the install.`,
          true,
        );
      }
      const size = (await fs.stat(dest)).size;
      if (size !== f.bytes) {
        throw new JobFail(
          'hash-mismatch',
          `File "${f.path}" is ${size} bytes but the catalog pins ${f.bytes} - refusing ` +
            `to install; nothing was written to the models dir.`,
        );
      }
      const sha = await hashFile(dest);
      if (sha !== f.sha256) {
        throw new JobFail(
          'hash-mismatch',
          `File "${f.path}" hashed ${sha} but the catalog pins ${f.sha256} - refusing ` +
            `to install; nothing was written to the models dir.`,
        );
      }
      verified.push({ path: f.path, sha256: sha, bytes: size });
      // the step carries WHICH file, so a 22-file 16 GB install reads as
      // motion instead of a repeating word (the UX pass called the bare
      // 'download' lines "repetitive ... we should have some indication")
      yield {
        t: 'progress',
        jobId,
        at: at(),
        step: `download:${f.path.split('/').at(-1)}`,
        done: i + 1,
        total,
      };
    }

    // atomic finalize: rename staging into place, then write the receipt.
    // Crash window (accepted, documented): a crash between the rename and the
    // receipt write leaves weights WITHOUT a receipt — verify reports
    // no-receipt, listInstalled/resolveInstalled treat it as not-installed,
    // and `models rm` (or the remnant sweep below) cleans it up.
    await fs.mkdir(`${opts.root}/${entry.id}`, { recursive: true });
    if (await dirExists(finalDir)) {
      // The sweep is for a receiptless remnant from exactly that crash window
      // (the receipt check above returned null). Before deleting anything,
      // RE-CHECK by direct stat: on a diverged filesystem view (D-039, MSIX
      // AppData virtualization) resolveInstalled can read null while a valid
      // receipt sits on disk, and the sweep would silently delete a healthy
      // multi-GB install. Refuse loudly instead - the refusal is correct on
      // ANY divergence, whatever its next cause turns out to be.
      let receiptStat: Stats | null = null;
      try {
        receiptStat = await fs.stat(`${finalDir}/${RECEIPT_FILE}`);
      } catch { /* truly absent - the remnant case */ }
      if (receiptStat !== null) {
        throw new JobFail(
          'install-conflict',
          `"${finalDir}/${RECEIPT_FILE}" EXISTS (${receiptStat.size} bytes, mtime ${
            receiptStat.mtime?.toISOString() ?? 'unknown'
          }) but was read as not-installed moments ago - two answers from one filesystem. ` +
            `The known cause is MSIX AppData virtualization: a packaged process (an AI ` +
            `agent's embedded shell, a Store app) sees a container-private overlay of ` +
            `%LOCALAPPDATA% (D-039). Refusing to delete the existing install. ` +
            `\`spritebook doctor\` reports this process's containment; ` +
            `\`spritebook models verify ${entry.id}\` audits the existing files.`,
        );
      }
      // receiptless remnant confirmed - unverified bytes, safe and honest to sweep
      await fs.rm(finalDir, { recursive: true });
    }
    await fs.rename(staging, finalDir);
    staging = undefined;

    const receipt = parseWith(
      InstallReceiptSchema,
      {
        schemaVersion: SCHEMA_VERSION,
        modelId: entry.id,
        version: version.version,
        installedAt: at(),
        platform,
        files: verified,
        licenseAccepted: entry.license.requiresAcceptance
          ? {
            name: entry.license.name,
            ...(entry.license.spdx !== undefined ? { spdx: entry.license.spdx } : {}),
            at: at(),
            fingerprint: await licenseFingerprint(entry.license),
          }
          : null,
        ...(opts.territory !== undefined ? { territoryDeclared: opts.territory } : {}),
        vram: {
          ...(version.minVramGb !== undefined ? { minGb: version.minVramGb } : {}),
          ...(vramGb !== null ? { detectedGb: vramGb } : {}),
          status: vram.status,
        },
      },
      `InstallReceipt (${entry.id}@${version.version})`,
    );
    const receiptPath = `${finalDir}/${RECEIPT_FILE}`;
    await fs.writeFile(receiptPath, canonicalJson(receipt));

    yield { t: 'artifact', jobId, at: at(), kind: 'install-receipt', path: receiptPath };
    if (version.runtime) {
      try {
        yield* prepareModelRuntime(version.runtime, jobId);
      } catch (error) {
        throw new JobFail(
          'model-setup-failed',
          `${
            message(error)
          } Weights and their receipt are retained. Run spritebook models setup ${entry.id}@${version.version}${
            opts.acceptLicense ? ' --accept-license' : ''
          } to retry setup.`,
          true,
        );
      }
    }
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - t0) / 1000 };
  } catch (err) {
    if (staging) await fs.rm(staging, { recursive: true }).catch(() => {});
    const fail = err instanceof JobFail ? err : new JobFail('install-failed', message(err));
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: fail.code,
      message: fail.message,
      retryable: fail.retryable,
    };
  }
}

export interface VerifyJobOpts {
  jobId: string;
  catalog: ModelCatalog;
  root: string;
  modelId: string;
  /** omitted -> the highest installed version */
  version?: string;
}

/**
 * Rehash every installed file against the RECEIPT and, when the version is
 * still in the catalog, against the CATALOG pins too. Event codes:
 * no-receipt, verify-failed.
 */
export async function* runVerifyJob(opts: VerifyJobOpts): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = opts.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  try {
    let version = opts.version;
    let receipt: InstallReceipt | null = null;
    if (version === undefined) {
      const hit = await resolveInstalled(opts.root, opts.modelId);
      if (hit) ({ version, receipt } = hit);
    } else {
      receipt = await getReceipt(opts.root, opts.modelId, version);
    }
    if (version === undefined || receipt === null) {
      const dir = version === undefined
        ? `${opts.root}/${opts.modelId}`
        : versionDir(opts.root, opts.modelId, version);
      const remnant = await dirExists(dir);
      throw new JobFail(
        'no-receipt',
        remnant
          ? `${dir} has files but no receipt - the install did not complete (crash ` +
            `window). Run \`spritebook models rm ${opts.modelId}\` and reinstall.`
          : `Model "${opts.modelId}"${version ? ` ${version}` : ''} is not installed ` +
            `under ${opts.root}.`,
      );
    }

    const dir = versionDir(opts.root, opts.modelId, version);
    const catVersion = opts.catalog.models.find((m) => m.id === opts.modelId)
      ?.versions.find((v) => v.version === version);
    const total = receipt.files.length;
    for (const [i, f] of receipt.files.entries()) {
      const path = `${dir}/${f.path}`;
      const stat = await fs.stat(path).catch(() => null);
      if (!stat?.isFile()) {
        throw new JobFail('verify-failed', `File "${f.path}" is missing from ${dir}.`);
      }
      if (stat.size !== f.bytes) {
        throw new JobFail(
          'verify-failed',
          `File "${f.path}" is ${stat.size} bytes on disk but the receipt recorded ` +
            `${f.bytes}.`,
        );
      }
      const sha = await hashFile(path);
      if (sha !== f.sha256) {
        throw new JobFail(
          'verify-failed',
          `File "${f.path}" hashes ${sha} on disk but the receipt recorded ${f.sha256} - ` +
            `the install is corrupt. Run \`spritebook models rm ${opts.modelId}\` and ` +
            `reinstall.`,
        );
      }
      const pin = catVersion?.files.find((cf) => cf.path === f.path);
      if (catVersion && !pin) {
        throw new JobFail('verify-failed', `Receipt file "${f.path}" is not pinned by the catalog`);
      }
      if (pin && (pin.sha256 !== sha || pin.bytes !== f.bytes)) {
        throw new JobFail(
          'verify-failed',
          `File "${f.path}" hashes ${sha} (matching its receipt) but the catalog now ` +
            `pins ${pin.sha256} - reinstall to pick up the catalog's pinned build.`,
        );
      }
      yield { t: 'progress', jobId, at: at(), step: 'verify', done: i + 1, total };
    }
    // the catalog comparison cuts both ways: a pin the receipt never saw
    // means this install no longer matches what the catalog ships
    for (const pin of catVersion?.files ?? []) {
      if (!receipt.files.some((f) => f.path === pin.path)) {
        throw new JobFail(
          'verify-failed',
          `The catalog now pins an additional file "${pin.path}" that this install does ` +
            `not have - reinstall to match the catalog.`,
        );
      }
    }
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - t0) / 1000 };
  } catch (err) {
    const fail = err instanceof JobFail ? err : new JobFail('verify-failed', message(err));
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: fail.code,
      message: fail.message,
      retryable: fail.retryable,
    };
  }
}

export interface RmJobOpts {
  jobId: string;
  root: string;
  modelId: string;
  /** omitted -> remove EVERY version of the model */
  version?: string;
}

/**
 * Remove one installed version (or the whole model dir when version is
 * omitted). Also the documented cleanup for crash-window remnants — it
 * removes the dir whether or not a receipt made it. Artifact-free. Event
 * codes: not-installed, rm-failed.
 */
export async function* runRmJob(opts: RmJobOpts): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = opts.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  try {
    const target = opts.version === undefined
      ? `${opts.root}/${opts.modelId}`
      : versionDir(opts.root, opts.modelId, opts.version);
    if (!(await dirExists(target))) {
      throw new JobFail(
        'not-installed',
        `Nothing to remove: ${target} does not exist. \`spritebook models list\` shows ` +
          `what is installed.`,
      );
    }
    await fs.rm(target, { recursive: true });
    if (opts.version !== undefined) {
      // sweep the model dir when the last version is gone — an empty dir is
      // not "installed" and must not linger in listings or on disk
      const parent = `${opts.root}/${opts.modelId}`;
      const left = await fs.readdir(parent, { withFileTypes: true }).catch(() => null);
      if (left !== null && left.length === 0) await fs.rmdir(parent);
    }
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - t0) / 1000 };
  } catch (err) {
    const fail = err instanceof JobFail ? err : new JobFail('rm-failed', message(err));
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: fail.code,
      message: fail.message,
      retryable: fail.retryable,
    };
  }
}

export interface ListedVersion {
  version: string;
  diskBytes: number;
  platforms: Platform[];
  minVramGb?: number;
  vramProfiles?: ModelVersion['vramProfiles'];
  installed: boolean;
  /** the D-009 form contract, verbatim from the catalog entry */
  paramsSchema: ModelVersion['paramsSchema'];
  defaults: Record<string, unknown>;
  operationDefaults?: ModelVersion['operationDefaults'];
  /** which knobs each operation accepts — a form rendering the union offers
   * the other operation's knobs, which is how a user comes to type one */
  operationParams?: ModelVersion['operationParams'];
  capabilities?: ModelVersion['capabilities'];
}

export interface ListedModel {
  id: string;
  kind: ModelEntry['kind'];
  displayName: string;
  license: {
    name: string;
    spdx?: string;
    requiresAcceptance: boolean;
    excludedTerritories?: string[];
  };
  versions: ListedVersion[];
}

/**
 * The `models list` projection: plain data, NOT events — the CLI renders it.
 * Catalog order is preserved; `installed` means a valid receipt exists.
 */
export async function runListQuery(
  opts: { catalog: ModelCatalog; root: string },
): Promise<ListedModel[]> {
  const installed = new Set(
    (await listInstalled(opts.root)).map((x) => `${x.id}@${x.version}`),
  );
  return opts.catalog.models.map((m) => ({
    id: m.id,
    kind: m.kind,
    displayName: m.displayName,
    license: {
      name: m.license.name,
      ...(m.license.spdx !== undefined ? { spdx: m.license.spdx } : {}),
      requiresAcceptance: m.license.requiresAcceptance,
      ...(m.license.excludedTerritories !== undefined
        ? { excludedTerritories: m.license.excludedTerritories }
        : {}),
    },
    versions: m.versions.map((v) => ({
      version: v.version,
      diskBytes: versionDiskBytes(v),
      platforms: v.platforms,
      ...(v.minVramGb !== undefined ? { minVramGb: v.minVramGb } : {}),
      ...(v.vramProfiles ? { vramProfiles: v.vramProfiles } : {}),
      installed: installed.has(`${m.id}@${v.version}`),
      // D-009 made paramsSchema catalog data so option forms could render
      // from it; the list row is where a GUI reads the catalog, so the
      // schema, defaults, and per-operation overlays ride along verbatim.
      paramsSchema: v.paramsSchema,
      defaults: v.defaults,
      ...(v.operationDefaults !== undefined ? { operationDefaults: v.operationDefaults } : {}),
      ...(v.operationParams !== undefined ? { operationParams: v.operationParams } : {}),
      ...(v.capabilities !== undefined ? { capabilities: v.capabilities } : {}),
    })),
  }));
}

function findEntry(catalog: ModelCatalog, id: string): ModelEntry {
  const entry = catalog.models.find((m) => m.id === id);
  if (entry) return entry;
  const ids = catalog.models.map((m) => m.id);
  throw new JobFail(
    'unknown-model',
    ids.length
      ? `No model "${id}" in the catalog. Available: ${ids.join(', ')}.`
      : `No model "${id}" in the catalog - it lists no models yet.`,
  );
}

function findVersion(entry: ModelEntry, version?: string): ModelVersion {
  if (version === undefined) {
    // highest by compareVersions — mirrors resolveInstalled's "highest installed"
    return [...entry.versions]
      .sort((a, b) => compareVersions(a.version, b.version))
      .at(-1)!;
  }
  const hit = entry.versions.find((v) => v.version === version);
  if (hit) return hit;
  throw new JobFail(
    'unknown-version',
    `Model "${entry.id}" has no version "${version}". Available: ` +
      `${entry.versions.map((v) => v.version).join(', ')}.`,
  );
}

async function dirExists(path: string): Promise<boolean> {
  const stat = await fs.stat(path).catch(() => null);
  return stat?.isDirectory() ?? false;
}

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
