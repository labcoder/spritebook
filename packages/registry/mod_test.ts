import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The registry seam speaks JobEvents only, including on failure — a broken
 * input yields a schema-valid error event, never a throw across the seam.
 * Going through loadCatalog() also exercises the bundled default-path
 * resolution (the percent-encoding trap from P3-T1 review F3 lives there).
 */
import { assert, assertEquals } from '@std/assert';
import { loadCatalog, runInstallJob } from './dist/mod.js';
import { collect } from './_testutil.ts';

test('registry seam: an unknown model becomes an error EVENT, not a throw', async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const catalog = await loadCatalog(); // the bundled catalog (empty until integration)
    const events = await collect(runInstallJob({
      jobId: 'job-seam',
      catalog,
      root: `${tmp}/models`,
      modelId: 'ghost',
      detected: { platform: 'windows-cpu', vramGb: null },
    }));
    assertEquals(events.map((e) => e.t).slice(0, 2), ['queued', 'started']);
    const err = events.at(-1)!;
    assert(err.t === 'error' && err.code === 'unknown-model', 'terminal error event');
    assert(!events.some((e) => e.t === 'done'), 'no done after failure');
  } finally {
    await fs.rm(tmp, { recursive: true });
  }
});
