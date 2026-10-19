import { promises as fs } from 'node:fs';
/**
 * Catalog layer (D-009): the committed catalog JSON is the single source of
 * model truth — ids, versions, licenses, territories, platform lists, VRAM
 * floors, and per-file sha256/byte pins. Backends and packs are catalog DATA,
 * never hardcoded integrations; this module only reads and validates.
 */
import { type ModelCatalog, ModelCatalogSchema, parseWith } from '@spritebook/schema';

// decodeURIComponent: URL.pathname percent-encodes (spaces, non-ASCII) — an
// install under "C:\Users\First Last\..." must still resolve (P3-T1 review F3)
const BUNDLED_CATALOG = decodeURIComponent(
  new URL('./catalog/models.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
);

/** Read + schema-validate a model catalog; defaults to the bundled file. */
export async function loadCatalog(path = BUNDLED_CATALOG): Promise<ModelCatalog> {
  const text = await fs.readFile(path, 'utf8').catch((err) => {
    throw new Error(`cannot read model catalog ${path}: ${message(err)}`);
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${message(err)}`);
  }
  return parseWith(ModelCatalogSchema, raw, `ModelCatalog (${path})`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
