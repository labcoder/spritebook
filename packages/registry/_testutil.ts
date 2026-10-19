import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Shared fixtures for the registry suite: schema-honest toy catalog builders,
 * a network-free fetcher rig, and a JobEvent collector that validates every
 * event against the schema as it streams. Test-only (underscore = never
 * exported from mod.ts).
 */
import type { JobEvent, ModelCatalog, ModelEntry, ModelVersion } from '@spritebook/schema';
import {
  canonicalJson,
  InstallReceiptSchema,
  JobEventSchema,
  ModelCatalogSchema,
  parseWith,
} from '@spritebook/schema';
import type { Fetcher } from './install.ts';

export const TOY_A = new TextEncoder().encode('toy checkpoint A: definitely not a real network\n');
export const TOY_B = new TextEncoder().encode('config: toy\nfaces: 50000\n');
export const URL_A = 'https://models.invalid/toy/model.ckpt';
export const URL_B = 'https://models.invalid/toy/config.yaml';

/** Test-side digest (WebCrypto directly) — cross-checks the package's hashFile. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toyVersion(over: Partial<ModelVersion> = {}): ModelVersion {
  return {
    version: '1.0',
    files: [{ path: 'model.ckpt', url: URL_A, sha256: 'a'.repeat(64), bytes: 1 }],
    platforms: ['windows-cpu', 'linux-cpu', 'macos-cpu'],
    paramsSchema: {},
    defaults: {},
    ...over,
  };
}

export function toyEntry(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: 'toy-rig',
    kind: 'rig',
    displayName: 'Toy Rig',
    license: { name: 'Toy Public License', requiresAcceptance: false },
    versions: [toyVersion()],
    ...over,
  };
}

/** Schema-validated catalog — fixtures stay honest about the frozen schema. */
export function toyCatalog(...models: ModelEntry[]): ModelCatalog {
  return parseWith(
    ModelCatalogSchema,
    { schemaVersion: 2, models: models.length ? models : [toyEntry()] },
    'toy catalog',
  );
}

/** Drain a job, validating every event against JobEventSchema as it streams. */
export async function collect(job: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const events: JobEvent[] = [];
  for await (const e of job) {
    parseWith(JobEventSchema, e, 'JobEvent (registry stream)');
    events.push(e);
  }
  return events;
}

/** Narrowing filter so tests can reach variant payloads without casts. */
export function ofType<T extends JobEvent['t']>(
  events: JobEvent[],
  t: T,
): Extract<JobEvent, { t: T }>[] {
  return events.filter((e): e is Extract<JobEvent, { t: T }> => e.t === t);
}

/** A rigged install: temp root + fixture source files + catalog pinned to their real hashes. */
export interface InstallRig {
  tmp: string;
  root: string;
  catalog: ModelCatalog;
  fetcher: Fetcher;
}

export async function installRig(
  entryOver: Partial<ModelEntry> = {},
  versionOver: Partial<ModelVersion> = {},
): Promise<InstallRig> {
  const tmp = await fs.mkdtemp(join(tmpdir(), 'sb-registry-'));
  const root = `${tmp}/models`;
  const src = `${tmp}/src`;
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(`${src}/model.ckpt`, TOY_A);
  await fs.writeFile(`${src}/config.yaml`, TOY_B);
  const files = [
    { path: 'model.ckpt', url: URL_A, sha256: await sha256Hex(TOY_A), bytes: TOY_A.byteLength },
    {
      path: 'cfg/config.yaml',
      url: URL_B,
      sha256: await sha256Hex(TOY_B),
      bytes: TOY_B.byteLength,
    },
  ];
  const catalog = toyCatalog(
    toyEntry({ versions: [toyVersion({ files, ...versionOver })], ...entryOver }),
  );
  const fetcher: Fetcher = async (url, dest) => {
    const name = url.split('/').at(-1)!;
    await fs.copyFile(`${src}/${name}`, dest); // fixture bytes only — never the network
  };
  return { tmp, root, catalog, fetcher };
}

/** Plant a minimal valid receipt directly on disk (installed-layer tests). */
export async function plantReceipt(root: string, id: string, version: string): Promise<void> {
  const dir = `${root}/${id}/${version}`;
  await fs.mkdir(dir, { recursive: true });
  const receipt = parseWith(
    InstallReceiptSchema,
    {
      schemaVersion: 2,
      modelId: id,
      version,
      installedAt: new Date().toISOString(),
      platform: 'windows-cpu',
      files: [{ path: 'model.ckpt', sha256: 'a'.repeat(64), bytes: 1 }],
      licenseAccepted: null,
      vram: { status: 'not-required' },
    },
    `planted receipt (${id}@${version})`,
  );
  await fs.writeFile(`${dir}/receipt.json`, canonicalJson(receipt));
}
