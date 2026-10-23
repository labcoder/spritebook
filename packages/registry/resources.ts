import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { freemem, totalmem } from 'node:os';

/** Probe the destination filesystem without creating it or guessing another drive. */
export async function availableDiskBytes(path: string): Promise<number | null> {
  let current = resolve(path);
  for (;;) {
    try {
      if (!(await fs.stat(current)).isDirectory()) return null;
      const stat = await fs.statfs(current);
      const bytes = stat.bavail * stat.bsize;
      return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Capacity is diagnostic data, never a claim that an unmeasured model fits. */
export async function hostResources(storagePath?: string) {
  return {
    ram: {
      totalBytes: totalmem(),
      freeBytes: freemem(),
      processAvailableBytes: process.availableMemory(),
    },
    diskFreeBytes: storagePath ? await availableDiskBytes(storagePath) : null,
  };
}
