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
  assertEquals(cat, { schemaVersion: 2, models: [] });
  const bytes = await Deno.readTextFile(BUNDLED);
  assertEquals(bytes, canonicalJson(cat), 'committed catalog must be canonical bytes + newline');
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
