import { licenseFingerprint } from './hash.ts';
import { dirname, resolve } from 'node:path';
import {
  canonicalJson,
  type Capability,
  type InstallReceipt,
  type ModelCatalog,
  type ModelEntry,
  type ModelVersion,
  type Platform,
  type ProjectPins,
} from '@spritebook/schema';
import { readPins } from './pins.ts';
import { resolveInstalled } from './installed.ts';
import { detectPlatform, gateLicense, gatePlatform, gateTerritory } from './gates.ts';
import { runVerifyJob } from './install.ts';

export interface ExecutionContext {
  workspace?: string;
  pinsPath?: string;
}

function refuse(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Bounded project discovery: one roster-root pins.json, or an explicit manifest path. */
export async function projectPins(context: ExecutionContext): Promise<ProjectPins | undefined> {
  const path = context.pinsPath ??
    (context.workspace ? resolve(dirname(resolve(context.workspace)), 'pins.json') : undefined);
  if (!path) return;
  if (!context.pinsPath) {
    try {
      await Deno.stat(path);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }
  }
  try {
    return await readPins(path);
  } catch (e) {
    refuse(
      'invalid-pins',
      `Cannot use project pins at "${path}": ${e instanceof Error ? e.message : e}`,
    );
  }
}

export function pinnedVersion(
  pins: ProjectPins | undefined,
  kind: 'models' | 'packs',
  id: string,
  requested?: string,
): string | undefined {
  if (!pins) return requested;
  const pin = Object.hasOwn(pins[kind], id) ? pins[kind][id] : undefined;
  if (!pin) refuse('pin-required', `Project pins have no ${kind} version for "${id}"`);
  if (requested !== undefined && requested !== pin) {
    refuse(
      'pin-mismatch',
      `Project pins require ${id}@${pin}, but this job requested ${requested}`,
    );
  }
  return pin;
}

export async function resolvePinnedInstalled(
  root: string,
  id: string,
  requested: string | undefined,
  context: ExecutionContext,
) {
  return await resolveInstalled(
    root,
    id,
    pinnedVersion(await projectPins(context), 'models', id, requested),
  );
}

/** Configurations outside measured profiles cannot borrow a different configuration's floor. */
export function executionVram(
  version: ModelVersion,
  operation: Capability,
  params: Record<string, unknown>,
) {
  const profiles = version.vramProfiles?.filter((p) => p.operation === operation);
  if (!version.vramProfiles) return version.minVramGb;
  const matches = (profiles ?? []).filter((p) =>
    Object.entries(p.params).every(([k, v]) => canonicalJson(params[k]) === canonicalJson(v))
  );
  if (!matches.length) {
    refuse(
      'vram-unqualified',
      `No measured VRAM profile for ${operation} with this configuration. Choose a catalog default or qualify the configuration first.`,
    );
  }
  return Math.max(...matches.map((p) => p.minGb));
}

/** Recheck declared terms, current hardware and every pinned file before loading weights. */
export async function verifyExecutionModel(opts: {
  root: string;
  catalog: ModelCatalog;
  entry: ModelEntry;
  version: ModelVersion;
  receipt: InstallReceipt;
  platform?: Platform;
}): Promise<void> {
  const { entry, version, receipt } = opts;
  if (receipt.modelId !== entry.id || receipt.version !== version.version) {
    refuse(
      'verify-failed',
      'Installed receipt identity does not match the selected backend version',
    );
  }
  const license = gateLicense(entry, {
    acceptLicense: receipt.licenseAccepted?.name === entry.license.name &&
      receipt.licenseAccepted?.spdx === entry.license.spdx &&
      receipt.licenseAccepted?.fingerprint === await licenseFingerprint(entry.license),
  });
  if (!license.ok) {
    refuse(
      license.code,
      `The installed ${entry.id}@${version.version} receipt has no acceptance for the current ${entry.license.name} terms. Read ${
        entry.license.url ?? 'the catalog license'
      }, then remove and reinstall this exact version with models install ${entry.id}@${version.version} --accept-license to record consent.`,
    );
  }
  const territory = gateTerritory(entry, { territory: receipt.territoryDeclared });
  const platform = gatePlatform(version, opts.platform ?? await detectPlatform());
  for (const gate of [license, territory, platform]) {
    if (!gate.ok) refuse(gate.code, gate.message);
  }
  for await (
    const event of runVerifyJob({
      jobId: 'verify-execution',
      root: opts.root,
      catalog: opts.catalog,
      modelId: entry.id,
      version: version.version,
    })
  ) {
    if (event.t === 'error') refuse(event.code, event.message);
  }
}

export async function verifyPackPin(
  pack: { id: string; version: string },
  context: ExecutionContext,
): Promise<void> {
  pinnedVersion(await projectPins(context), 'packs', pack.id, pack.version);
}
