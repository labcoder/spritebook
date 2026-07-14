/**
 * T2 acceptance: serialize -> parse -> serialize is BYTE-IDENTICAL for every
 * fixture. Fixtures are canonical bytes on disk (.gitattributes pins LF);
 * regenerate with fixtures/_generate.ts.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { z } from 'zod';
import { canonicalJson, parseWith } from './canonical.ts';
import { AnimationPackSchema, ModelEntrySchema } from './registry.ts';
import { ProjectSchema } from './project.ts';
import { CharacterManifestSchema } from './character.ts';
import { BakeManifestSchema } from './bake.ts';
import { CacheKeyInputsSchema } from './cache.ts';
import { ManifestPatchSchema } from './patch.ts';
import { UiLayoutPrefsSchema } from './prefs.ts';
import { JobEventSchema } from './jobs.ts';

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

const read = (rel: string) => Deno.readTextFile(new URL(`./fixtures/${rel}`, import.meta.url));

for (const [rel, schema] of FIXTURES) {
  Deno.test(`round-trip byte-identical: ${rel}`, async () => {
    const bytes = await read(rel);
    assert(!bytes.includes('\r'), 'fixture must be LF (check .gitattributes)');
    const validated = parseWith(schema, JSON.parse(bytes), rel);
    assertEquals(canonicalJson(validated), bytes);
  });
}

Deno.test('round-trip byte-identical: valid/job-events.ndjson (per line)', async () => {
  const bytes = await read('valid/job-events.ndjson');
  const lines = bytes.split('\n').filter((l) => l.length > 0);
  assertEquals(lines.length, 7, 'one line per event vocabulary entry');
  for (const line of lines) {
    const validated = parseWith(JobEventSchema, JSON.parse(line), 'job-events line');
    assertEquals(canonicalJson(validated), line + '\n');
  }
});
