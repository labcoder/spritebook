import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { BakeManifest } from '@spritebook/schema';

/** Portable relative file names: Windows separators, drives and parent aliases are refused on every OS. */
export function fileParts(name: string): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(name)) {
    throw new Error(`Unsafe export artifact path "${name}"`);
  }
  return name.split('/');
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The chosen root may be redirected; no child link may redirect an artifact read or write. */
export async function regularPath(root: string, name: string, missing = false): Promise<string> {
  const parts = fileParts(name);
  let path = root;
  for (const [i, part] of parts.entries()) {
    path = resolve(path, part);
    const info = await fs.lstat(path).catch((error) => {
      if (missing && error.code === 'ENOENT') return null;
      throw error;
    });
    if (info === null) continue;
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Export artifact must be a regular file inside its directory: ${path}`);
    }
  }
  if (!isInside(root, path)) throw new Error(`Export artifact escaped its directory: ${name}`);
  return path;
}

/** Shared preflight for the job and direct formatters; never trust names from a saved bake. */
export async function atlasFiles(manifest: BakeManifest, bakeDir: string) {
  for (const page of manifest.atlases) {
    fileParts(page.png);
    if (!/\.png$/i.test(page.png)) {
      throw new Error(`Unsafe export artifact path "${page.png}": expected PNG`);
    }
  }
  const root = await fs.realpath(bakeDir);
  const files = new Map<string, { source: string; name: string }>();
  const names = new Map<string, string>();
  for (const page of manifest.atlases.filter((page) => page.pass === 'lit')) {
    const name = fileParts(page.png).at(-1)!;
    const old = names.get(name.toLowerCase());
    if (old && old !== page.png) throw new Error(`Atlas files have the same export name: ${name}`);
    names.set(name.toLowerCase(), page.png);
    files.set(page.png, { source: await regularPath(root, page.png), name });
  }
  return files;
}
