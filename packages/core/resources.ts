import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Installed launchers set one application-owned root; development uses compiled packages. */
export function resourcePath(packageName: string, path = ''): string {
  if (process.env.SPRITEBOOK_RESOURCES) {
    return join(process.env.SPRITEBOOK_RESOURCES, packageName, path);
  }
  const base = packageName === 'sidecar'
    ? new URL('../../../sidecar/', import.meta.url)
    : new URL('.', import.meta.resolve(`@spritebook/${packageName}`));
  return join(fileURLToPath(base), path);
}
