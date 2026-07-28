/**
 * Capabilities: what a backend can be ASKED to do, and with which defaults.
 *
 * The `retexture` verb must find its backend by asking who can retexture, never
 * by naming trellis2 — that is the difference between a second texturing model
 * being catalog data and being a code change (D-009). These tests pin the two
 * halves that promise makes: resolution by capability, and defaults that differ
 * per operation on ONE model.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  type Capability,
  defaultsFor,
  ModelCatalogSchema,
  type ModelEntry,
  versionCan,
  versionCapabilities,
} from '@spritebook/schema';
import { loadCatalog } from './mod.ts';
import { toyEntry, toyVersion } from './_testutil.ts';

/** Exactly what the verb will do: ask the catalog, not a hardcoded id. */
function backendsFor(models: ModelEntry[], op: Capability): string[] {
  return models.filter((m) => m.versions.some((v) => versionCan(m.kind, v, op))).map((m) => m.id);
}

Deno.test('a verb resolves its backend by capability, not by name', async () => {
  const cat = await loadCatalog();
  // the real backend and the weightless stand-in that makes the path testable
  assertEquals(backendsFor(cat.models, 'retexture'), ['trellis2-4b', 'fixture-gen']);
  // and the same lookup finds generators, so one mechanism serves every verb
  assert(backendsFor(cat.models, 'gen3d').includes('trellis2-4b'));
  assertEquals(backendsFor(cat.models, 'rig'), ['unirig']);
  // the entry `kind` counts without being restated in `capabilities` — a
  // caller checking only one field must never miss a backend
  const unirig = cat.models.find((m) => m.id === 'unirig')!;
  assertEquals(unirig.versions[0].capabilities, undefined);
  assertEquals([...versionCapabilities(unirig.kind, unirig.versions[0])], ['rig']);
});

Deno.test('trellis2 retextures with a bigger seed ladder than it generates with', async () => {
  const cat = await loadCatalog();
  const t = cat.models.find((m) => m.id === 'trellis2-4b')!;
  const v = t.versions[0];
  // measured: the texture decoder collapses on ~5% of seeds when generating and
  // 37.5% when retexturing, so one shared budget is wrong for one of them
  assertEquals(defaultsFor(v, 'gen3d').textureRetries, 2);
  assertEquals(defaultsFor(v, 'retexture').textureRetries, 5);
  // the SHARED block holds nothing about retries at all. A number that is
  // right for one operation and wrong for the other does not belong where it
  // reads as applying to both.
  assertEquals(v.defaults.textureRetries, undefined);
  // everything genuinely shared still is
  assertEquals(defaultsFor(v, 'retexture').lowVram, v.defaults.lowVram);
  assertEquals(defaultsFor(v, 'retexture').resolution, 512);
  assertEquals(defaultsFor(v, 'gen3d').resolution, undefined);
});

Deno.test('defaults for an operation the version cannot do are refused', () => {
  const withOp = (capabilities?: Capability[]) =>
    ModelCatalogSchema.safeParse({
      schemaVersion: 2,
      models: [toyEntry({
        versions: [toyVersion({ capabilities, operationDefaults: { retexture: { seed: 1 } } })],
      })],
    });
  // dead data that READS as configuration: a user sets a budget under a key
  // nothing consults and watches it do nothing
  const bad = withOp();
  assert(!bad.success);
  assert(
    JSON.stringify(bad.error.issues).includes('does not declare it can do'),
    `message must name the cause: ${JSON.stringify(bad.error.issues)}`,
  );
  assert(withOp(['retexture']).success, 'declared capability admits its defaults');
});
