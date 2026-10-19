import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
/**
 * MSIX AppData virtualization detection (D-039). A Windows process with
 * package identity — including every child a packaged app spawns — gets a
 * copy-on-write view of `%LOCALAPPDATA%`: writes are redirected into
 * `%LOCALAPPDATA%\Packages\<pkg>\LocalCache\Local\...` and reads see that
 * overlay first. Two processes on one machine can then hold two internally
 * consistent models stores at the SAME path string, which is exactly the
 * field incident the install-conflict guard refuses on: model installs run
 * inside such a container are invisible to unpackaged processes.
 *
 * Detection is a WRITE PROBE, because it is the only observable that cannot
 * lie: directory listings read through the very merge they would need to
 * detect (the removed probeInstallState was blind by construction). The
 * probe writes a marker through the normal path, then looks for its
 * physical copy in each package's LocalCache backing store — the backing
 * paths themselves are not virtualized.
 */

export interface VirtualizationReport {
  virtualized: boolean;
  /** the owning package dir name, e.g. "Claude_pzs8sxrjxfjjc" */
  pkg?: string;
  /** where the marker physically landed */
  backing?: string;
}

/**
 * Scan `<localAppData>/Packages/<pkg>/LocalCache/Local/<marker>` for the
 * physical copy of a marker just written to `<localAppData>/<marker>`.
 * Split out so the scan is testable against a plain directory tree.
 */
export async function findMarkerBacking(
  localAppData: string,
  marker: string,
): Promise<{ pkg: string; backing: string } | null> {
  let pkgs: Dirent[];
  try {
    pkgs = await fs.readdir(`${localAppData}/Packages`, { withFileTypes: true });
  } catch {
    return null; // no Packages dir - nothing packaged has ever run
  }
  for (const p of pkgs) {
    if (!p.isDirectory()) continue;
    const backing = `${localAppData}/Packages/${p.name}/LocalCache/Local/${marker}`;
    try {
      await fs.stat(backing);
      return { pkg: p.name, backing };
    } catch {
      // not this package
    }
  }
  return null;
}

/**
 * Is THIS process's view of `%LOCALAPPDATA%` a container-private overlay?
 * Never throws — a diagnostic that fails reads as "not virtualized".
 */
export async function detectAppDataVirtualization(
  getEnv: (key: string) => string | undefined = (key) => process.env[key],
  os: NodeJS.Platform | 'windows' = (process.platform === 'win32' ? 'windows' : process.platform),
): Promise<VirtualizationReport> {
  if (os !== 'windows') return { virtualized: false };
  const local = getEnv('LOCALAPPDATA');
  if (!local) return { virtualized: false };
  const marker = `.sb-vfs-probe-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(`${local}/${marker}`, 'spritebook virtualization probe (D-039)');
  } catch {
    return { virtualized: false };
  }
  try {
    const hit = await findMarkerBacking(local, marker);
    return hit ? { virtualized: true, ...hit } : { virtualized: false };
  } finally {
    // where contained this removes the overlay copy (the real dir never had
    // it), where not it removes the real file - no tombstone risk either way
    await fs.rm(`${local}/${marker}`).catch(() => {});
  }
}

/**
 * One sentence for not-installed error messages: empty when the view is
 * real, the explanation when it is an overlay. Rides the cold error path
 * only — the probe costs one write plus one stat per installed package.
 */
export async function virtualizationNote(
  getEnv: (key: string) => string | undefined = (key) => process.env[key],
  os: NodeJS.Platform | 'windows' = (process.platform === 'win32' ? 'windows' : process.platform),
): Promise<string> {
  const v = await detectAppDataVirtualization(getEnv, os);
  if (!v.virtualized) return '';
  return ` NOTE: this process runs inside the "${v.pkg}" MSIX container, so its ` +
    `%LOCALAPPDATA% models store is container-private (D-039) - a model installed from a ` +
    `normal terminal is invisible here and vice versa. Install from the terminal that runs ` +
    `the app, or set SPRITEBOOK_MODELS_DIR outside AppData.`;
}

/** Case- and separator-insensitive "is this root inside %LOCALAPPDATA%?". */
export function rootUnderLocalAppData(
  root: string,
  getEnv: (key: string) => string | undefined = (key) => process.env[key],
): boolean {
  const local = getEnv('LOCALAPPDATA');
  if (!local) return false;
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return norm(root).startsWith(norm(local) + '/');
}
