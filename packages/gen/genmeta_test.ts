/**
 * The receipt must record the seed the backend ACTUALLY used.
 *
 * `trellis2` re-samples past a seed-dependent black texture, so the requested
 * and effective seeds genuinely differ. A receipt naming the requested one
 * would make "re-run exactly this" reproduce the FAILURE rather than the
 * result — the one thing a provenance record must never do.
 */
import { assertEquals } from 'jsr:@std/assert@1';
import { readEffectiveSeed } from './gen.ts';

async function withMeta(body: string, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'sb-genmeta-' });
  try {
    const p = `${dir}/gen-meta.json`;
    await Deno.writeTextFile(p, body);
    await fn(p);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('the effective seed wins over the requested one', async () => {
  await withMeta(
    JSON.stringify({ requestedSeed: 42, effectiveSeed: 44, seedsTried: [42, 43, 44] }),
    async (p) => assertEquals(await readEffectiveSeed(p, 42), 44),
  );
});

Deno.test('a backend that never retried reports the seed it was given', async () => {
  await withMeta(
    JSON.stringify({ requestedSeed: 7, effectiveSeed: 7, seedsTried: [7] }),
    async (p) => assertEquals(await readEffectiveSeed(p, 7), 7),
  );
});

Deno.test('no meta artifact at all: the requested seed stands', async () => {
  // most backends never emit one; only those that can re-sample do
  assertEquals(await readEffectiveSeed(undefined, 11), 11);
});

Deno.test('a broken meta file never costs a good mesh', async () => {
  // Same rule `rig` follows when its recording step fails: the real work is on
  // disk, and throwing it away over bookkeeping is worse than a stale field.
  for (
    const body of [
      'not json at all',
      '{}',
      '{"effectiveSeed":"nine"}',
      '{"effectiveSeed":-1}',
      '{"effectiveSeed":1.5}',
    ]
  ) {
    await withMeta(body, async (p) => assertEquals(await readEffectiveSeed(p, 5), 5, body));
  }
  assertEquals(await readEffectiveSeed('/no/such/file.json', 5), 5);
});
