import { promises as fs } from 'node:fs';
/**
 * Validate and canonicalize the bundled model catalog. Entries are authored
 * by hand (or pasted from a draft); this tool is the only writer of the
 * committed bytes, so the file stays schema-valid canonical JSON forever.
 *
 *   deno run --allow-read --allow-write tools/registry/canonicalize-catalog.ts [draft.json]
 *
 * With no argument it re-canonicalizes packages/registry/catalog/models.json
 * in place; with a draft path it validates the draft and replaces the bundled
 * catalog with it.
 */
import { canonicalJson, ModelCatalogSchema, parseWith } from '@spritebook/schema';

const target = decodeURIComponent(
  new URL('../../packages/registry/catalog/models.json', import.meta.url)
    .pathname
    .replace(/^\/([A-Za-z]:)/, '$1'),
);
const source = process.argv.slice(2)[0] ?? target;
const catalog = parseWith(
  ModelCatalogSchema,
  JSON.parse(await fs.readFile(source, 'utf8')),
  'bundled ModelCatalog',
);
await fs.writeFile(target, canonicalJson(catalog));
console.log(
  `wrote ${target}: ${catalog.models.length} entries, canonical bytes`,
);
