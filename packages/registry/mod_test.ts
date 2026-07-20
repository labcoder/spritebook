/**
 * The registry seam speaks JobEvents only, including on failure — a broken
 * input yields a schema-valid error event, never a throw across the seam.
 * Going through loadCatalog() also exercises the bundled default-path
 * resolution (the percent-encoding trap from P3-T1 review F3 lives there).
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { loadCatalog, runInstallJob } from './mod.ts';
import { collect } from './_testutil.ts';

Deno.test('registry seam: an unknown model becomes an error EVENT, not a throw', async () => {
  const tmp = await Deno.makeTempDir();
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
    await Deno.remove(tmp, { recursive: true });
  }
});
