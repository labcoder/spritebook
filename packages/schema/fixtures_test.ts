import { promises as fs } from 'node:fs';
import { test } from 'node:test';
/**
 * T2 acceptance: serialize -> parse -> serialize is BYTE-IDENTICAL for every
 * fixture. Fixtures are canonical bytes on disk (.gitattributes pins LF);
 * regenerate with fixtures/_generate.ts.
 */
import { assert, assertEquals } from '@std/assert';
import type { z } from 'zod';
import { canonicalJson, parseWith } from './dist/canonical.js';
import { AnimationPackSchema, ModelEntrySchema } from './dist/registry.js';
import { ProjectSchema } from './dist/project.js';
import { CharacterManifestSchema } from './dist/character.js';
import { BakeManifestSchema } from './dist/bake.js';
import { CacheKeyInputsSchema } from './dist/cache.js';
import { ManifestPatchSchema } from './dist/patch.js';
import { UiLayoutPrefsSchema } from './dist/prefs.js';
import { JobEventSchema } from './dist/jobs.js';

const FIXTURES: Array<[string, z.ZodType]> = [
  ['valid/model-entry.json', ModelEntrySchema],
  ['valid/animation-pack.json', AnimationPackSchema],
  ['valid/project.json', ProjectSchema],
  ['valid/character-manifest.json', CharacterManifestSchema],
  ['valid/bake-manifest.json', BakeManifestSchema],
  ['valid/cache-key-inputs.json', CacheKeyInputsSchema],
  ['valid/manifest-patch.json', ManifestPatchSchema],
  ['valid/ui-layout-prefs.json', UiLayoutPrefsSchema],
];

const read = (rel: string) => fs.readFile(new URL(`./fixtures/${rel}`, import.meta.url), 'utf8');

for (const [rel, schema] of FIXTURES) {
  test(`round-trip byte-identical: ${rel}`, async () => {
    const bytes = await read(rel);
    assert(!bytes.includes('\r'), 'fixture must be LF (check .gitattributes)');
    const validated = parseWith(schema, JSON.parse(bytes), rel);
    assertEquals(canonicalJson(validated), bytes);
  });
}

test('round-trip byte-identical: valid/job-events.ndjson (per line)', async () => {
  const bytes = await read('valid/job-events.ndjson');
  const lines = bytes.split('\n').filter((l) => l.length > 0);
  assertEquals(lines.length, 7, 'one line per event vocabulary entry');
  for (const line of lines) {
    const validated = parseWith(JobEventSchema, JSON.parse(line), 'job-events line');
    assertEquals(canonicalJson(validated), line + '\n');
  }
});
