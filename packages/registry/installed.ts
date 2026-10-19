import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
/**
 * Installed layer (D-009): `<root>/<modelId>/<version>/` holds the weight
 * files at their catalog-declared relative paths plus `receipt.json`. The
 * receipt IS the installed marker — weights without one (the rename-then-
 * write crash window documented in install.ts) are treated as not-installed
 * everywhere here, and `models rm` cleans them up.
 */
import { type InstallReceipt, InstallReceiptSchema, parseWith } from '@spritebook/schema';

export const RECEIPT_FILE = 'receipt.json';

/** `<root>/<modelId>/<version>` — one spelling for every module. */
export function versionDir(root: string, id: string, version: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) {
    throw Object.assign(new Error(`Invalid model id/version path: ${id}@${version}`), {
      code: 'invalid-pins',
    });
  }
  return `${root}/${id}/${version}`;
}

/**
 * Models root: `SPRITEBOOK_MODELS_DIR` wins; else the platform data dir —
 * `%LOCALAPPDATA%/spritebook/models` on Windows, `~/Library/Application
 * Support/spritebook/models` on macOS, `$XDG_DATA_HOME/spritebook/models`
 * (or `~/.local/share/...`) on Linux. Env and os are injectable for tests.
 */
export function defaultModelsRoot(
  getEnv: (key: string) => string | undefined = (key) => process.env[key],
  os: NodeJS.Platform | 'windows' = (process.platform === 'win32' ? 'windows' : process.platform),
): string {
  const override = getEnv('SPRITEBOOK_MODELS_DIR');
  if (override) return override;
  if (os === 'windows') {
    const base = getEnv('LOCALAPPDATA');
    if (!base) {
      throw new Error('LOCALAPPDATA is not set - set SPRITEBOOK_MODELS_DIR to choose a models dir');
    }
    return `${base}/spritebook/models`;
  }
  const home = getEnv('HOME');
  if (!home) {
    throw new Error('HOME is not set - set SPRITEBOOK_MODELS_DIR to choose a models dir');
  }
  if (os === 'darwin') return `${home}/Library/Application Support/spritebook/models`;
  const data = getEnv('XDG_DATA_HOME') || `${home}/.local/share`;
  return `${data}/spritebook/models`;
}

/**
 * Deterministic "semver-ish" order: split on '.', compare segment-wise —
 * two numeric segments compare numerically ('1.10' > '1.9'), a numeric
 * segment sorts before a non-numeric one, otherwise plain string compare;
 * the shorter version loses a tie ('1.2' < '1.2.1'). Deliberately simple:
 * catalogs pin exact versions, this only picks "highest" when a version is
 * omitted.
 */
export function compareVersions(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The receipt for one installed version, or null when there is none (not
 * installed, or the install crashed before the receipt landed). A receipt
 * that exists but does not validate THROWS — corruption is loud, never a
 * silent "not installed".
 */
export async function getReceipt(
  root: string,
  id: string,
  version: string,
): Promise<InstallReceipt | null> {
  const path = `${versionDir(root, id, version)}/${RECEIPT_FILE}`;
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${message(err)}`);
  }
  const receipt = parseWith(InstallReceiptSchema, raw, `InstallReceipt (${path})`);
  if (receipt.modelId !== id || receipt.version !== version) {
    throw Object.assign(new Error(`Receipt identity does not match ${id}@${version} at ${path}`), {
      code: 'verify-failed',
    });
  }
  return receipt;
}

export interface InstalledVersion {
  id: string;
  version: string;
  receipt: InstallReceipt;
}

/**
 * Every receipted install under the root, sorted by id then version. Dirs
 * without a receipt are skipped (crash window = not installed), dot-dirs are
 * skipped (crashed `.staging-*` leftovers must not break listing), and a
 * receipt that fails validation throws via getReceipt.
 */
export async function listInstalled(root: string): Promise<InstalledVersion[]> {
  let modelDirs: Dirent[];
  try {
    modelDirs = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []; // no root yet = nothing installed
    throw err;
  }
  const out: InstalledVersion[] = [];
  for (const m of modelDirs) {
    if (!m.isDirectory() || m.name.startsWith('.')) continue;
    for (const v of await fs.readdir(`${root}/${m.name}`, { withFileTypes: true })) {
      if (!v.isDirectory()) continue;
      const receipt = await getReceipt(root, m.name, v.name);
      if (receipt) out.push({ id: m.name, version: v.name, receipt });
    }
  }
  out.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : compareVersions(a.version, b.version));
  return out;
}

/**
 * Resolve an installed version: exact when given, else the highest installed
 * one by compareVersions. Null when nothing (receipted) is installed.
 */
export async function resolveInstalled(
  root: string,
  id: string,
  version?: string,
): Promise<{ version: string; receipt: InstallReceipt } | null> {
  if (version !== undefined) {
    const receipt = await getReceipt(root, id, version);
    return receipt ? { version, receipt } : null;
  }
  const mine = (await listInstalled(root)).filter((x) => x.id === id);
  const top = mine.at(-1); // listInstalled sorts ascending per id
  return top ? { version: top.version, receipt: top.receipt } : null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The forensic probeInstallState that used to live here is gone: the field
// incident it existed to catch is root-caused (D-039, MSIX AppData
// virtualization), and a directory-listing probe was blind to it by
// construction - it read through the very overlay it needed to detect. The
// honest replacement is virtualization.ts's write probe.
