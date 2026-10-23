import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assert, assertEquals } from '@std/assert';
import { availableDiskBytes } from './dist/resources.js';

test('disk probe uses the existing destination ancestor without creating directories', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'sb-resource-'));
  try {
    const missing = join(root, 'models', 'nested');
    const free = await availableDiskBytes(missing);
    assert(free !== null && free > 0);
    assertEquals(await fs.readdir(root), []);
    // A file cannot be traversed: do not borrow the parent drive's capacity.
    await fs.writeFile(join(root, 'file'), 'owned fixture');
    assertEquals(await availableDiskBytes(join(root, 'file', 'nested')), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
