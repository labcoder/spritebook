/**
 * Catalog layer: the bundled file is canonical bytes and validates; duplicate
 * ids and traversal paths are rejected at the SCHEMA level (frozen in
 * packages/schema/registry.ts) — proven here so install can rely on it.
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { canonicalJson, ModelCatalogSchema, SchemaError } from '@spritebook/schema';
import { loadCatalog } from './mod.ts';
import { toyEntry, toyVersion } from './_testutil.ts';

// same resolution dance as loadCatalog's default (decode AFTER the drive strip)
const BUNDLED = decodeURIComponent(
  new URL('./catalog/models.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
);

Deno.test('bundled catalog: default path resolves, validates, and is canonicalJson bytes', async () => {
  const cat = await loadCatalog();
  const bytes = await Deno.readTextFile(BUNDLED);
  assertEquals(bytes, canonicalJson(cat), 'committed catalog must be canonical bytes + newline');
  // the first real entries (P3-T2): pinned from P0-T4 evidence + a verified
  // local download — ids are load-bearing for the CLI and the prep verb
  const ids = cat.models.map((m) => m.id);
  assert(ids.includes('rembg-u2net'), `rembg-u2net entry present (got: ${ids.join(', ')})`);
  assert(ids.includes('unirig'), `unirig entry present (got: ${ids.join(', ')})`);
  const unirig = cat.models.find((m) => m.id === 'unirig')!;
  assert(
    unirig.versions[0].platforms.every((p) => p.endsWith('-cuda')),
    'unirig is honestly CUDA-only (D-009 platform verdict)',
  );
});

Deno.test('catalog: duplicate model ids are rejected', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/models.json`;
    // two entries sharing an id — built raw on purpose (toyCatalog would refuse)
    await Deno.writeTextFile(
      path,
      canonicalJson({ schemaVersion: 2, models: [toyEntry(), toyEntry()] }),
    );
    await assertRejects(() => loadCatalog(path), SchemaError, 'duplicate id');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('catalog: weight-file paths cannot traverse or escape (schema-level)', () => {
  for (const path of ['../evil.ckpt', 'weights/../evil.ckpt', '/etc/evil', 'C:/evil', '.hidden']) {
    const result = ModelCatalogSchema.safeParse({
      schemaVersion: 2,
      models: [toyEntry({
        versions: [toyVersion({
          files: [{ path, url: 'https://models.invalid/x', sha256: 'a'.repeat(64), bytes: 1 }],
        })],
      })],
    });
    assert(!result.success, `path "${path}" must be rejected`);
  }
  // and the grammar still admits ordinary nested relative paths
  const ok = ModelCatalogSchema.safeParse({
    schemaVersion: 2,
    models: [toyEntry({
      versions: [toyVersion({
        files: [{
          path: 'ckpt/skin.v2/model_fp16.safetensors',
          url: 'https://models.invalid/x',
          sha256: 'a'.repeat(64),
          bytes: 1,
        }],
      })],
    })],
  });
  assert(ok.success);
});

Deno.test('loadCatalog: missing file and broken JSON throw actionably', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(() => loadCatalog(`${dir}/none.json`), Error, 'cannot read model catalog');
    await Deno.writeTextFile(`${dir}/bad.json`, '{nope');
    await assertRejects(() => loadCatalog(`${dir}/bad.json`), Error, 'invalid JSON');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('unirig ships the opt-350m config, so `rig` needs no ambient HF cache', async () => {
  // The P3 exit measurement caught this: `rig` warned that it was reading
  // UniRig's architecture config from THIS machine's Hugging Face cache. The
  // exit criterion is measured "on a fresh machine", where there is no such
  // cache and the verb refuses outright — so the 5.6-minute run was real for
  // one box and unproven for the one the criterion names.
  const cat = await loadCatalog();
  const v = cat.models.find((m) => m.id === 'unirig')!.versions[0];
  const cfg = v.files.find((f) => f.path === 'opt-350m/config.json');
  assert(cfg, `unirig must ship the config: ${v.files.map((f) => f.path).join(', ')}`);
  // pinned to a REVISION, not a branch: `main` would let the bytes move out
  // from under the hash and turn every install into a verify failure
  assert(
    /\/resolve\/[0-9a-f]{40}\//.test(cfg.sha256 ? cfg.url : ''),
    `pin the revision, not a branch: ${cfg.url}`,
  );
  assertEquals(cfg.bytes, 644, 'architecture hyperparameters only - no weights');
  // and it must land where the adapter looks (llm_config_source: modelDir/opt-350m)
  assert(cfg.path.startsWith('opt-350m/'), cfg.path);
});
