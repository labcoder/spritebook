import { test } from 'node:test';
/**
 * Capabilities: what a backend can be ASKED to do, and with which defaults.
 *
 * The `retexture` verb must find its backend by asking who can retexture, never
 * by naming trellis2 — that is the difference between a second texturing model
 * being catalog data and being a code change (D-009). These tests pin the two
 * halves that promise makes: resolution by capability, and defaults that differ
 * per operation on ONE model.
 */
import { assert, assertEquals } from '@std/assert';
import {
  type Capability,
  defaultsFor,
  ModelCatalogSchema,
  type ModelEntry,
  operationsAccepting,
  paramsSchemaFor,
  versionCan,
  versionCapabilities,
} from '@spritebook/schema';
import { validateParams } from '@spritebook/core';
import { loadCatalog } from './dist/mod.js';
import { toyEntry, toyVersion } from './_testutil.ts';

/** Exactly what the verb will do: ask the catalog, not a hardcoded id. */
function backendsFor(models: ModelEntry[], op: Capability): string[] {
  return models.filter((m) => m.versions.some((v) => versionCan(m.kind, v, op))).map((m) => m.id);
}

test('a verb resolves its backend by capability, not by name', async () => {
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

test('trellis2 retextures with a bigger seed ladder than it generates with', async () => {
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
  // everything genuinely shared still is, and `lowVram` is really there to
  // share - an assertion that both sides are undefined would prove nothing
  assertEquals(v.defaults.lowVram, true);
  assertEquals(defaultsFor(v, 'retexture').lowVram, true);
  assertEquals(defaultsFor(v, 'gen3d').lowVram, true);
  assertEquals(defaultsFor(v, 'retexture').resolution, 512);
  assertEquals(defaultsFor(v, 'gen3d').resolution, undefined);

  // A1 (spikes/trellis2/A1-SWEEP.md): texture guidance 3.5 with rescale 0.2 on
  // BOTH operations, frozen by the 140-sample sweep and the maintainer's pick
  // from its renders. gen3d's guidance was silently 1.0 (CFG off) until then —
  // "the character everyone evaluated was textured by an unguided sampler" —
  // and retexture's 7.5 predated the rescale knob existing at all. Explicit
  // here so every receipt records what ran; silence is not a default.
  assertEquals(defaultsFor(v, 'gen3d').textureGuidance, 3.5);
  assertEquals(defaultsFor(v, 'gen3d').textureGuidanceRescale, 0.2);
  assertEquals(defaultsFor(v, 'retexture').textureGuidance, 3.5);
  assertEquals(defaultsFor(v, 'retexture').textureGuidanceRescale, 0.2);
});

test('every entry can actually RUN every operation it declares', async () => {
  // The test that was missing, and the break it missed: `trellis2-4b` declared
  // retexture, carried `resolution` and `textureRetries` as operation defaults,
  // and had a `paramsSchema` with `additionalProperties: false` that listed
  // neither. Both of its operations were rejected core-side before a process
  // could be spawned - by the entry's own schema, against the entry's own
  // defaults. Declaring a capability is not the same as being able to do it.
  const cat = await loadCatalog();
  for (const m of cat.models) {
    for (const v of m.versions) {
      for (const op of versionCapabilities(m.kind, v)) {
        const params = defaultsFor(v, op);
        // the OPERATION's schema, not the union: a default parked under a knob
        // its own operation does not accept is the same class of dead data
        const check = validateParams(paramsSchemaFor(v, op), params);
        assert(
          check.ok,
          `${m.id}@${v.version} cannot run "${op}": its own paramsSchema rejects its own ` +
            `defaults ${JSON.stringify(params)} - ${check.ok ? '' : check.errors.join('; ')}`,
        );
      }
    }
  }
});

test('one schema, two operations: each sees only the knobs it accepts', async () => {
  // The field report: `gen --adjust resolution=1024` was refused with "params
  // must NOT have additional properties", because trellis2's union schema
  // carries the retexture sampler's knob and nothing said whose it was.
  const cat = await loadCatalog();
  const v = cat.models.find((m) => m.id === 'trellis2-4b')!.versions[0];
  const knobs = (op: Capability) => Object.keys(paramsSchemaFor(v, op).properties as object).sort();

  assert(!knobs('gen3d').includes('resolution'), "resolution is the retexture sampler's");
  assertEquals(operationsAccepting(v, 'resolution'), ['retexture']);
  for (const genOnly of ['candidates', 'decimationTarget', 'pipelineType', 'steps']) {
    assert(!knobs('retexture').includes(genOnly), `${genOnly} does not survive a retexture`);
    assertEquals(operationsAccepting(v, genOnly), ['gen3d']);
  }
  // and the genuinely shared ones stay shared, or this proves nothing
  assertEquals(operationsAccepting(v, 'textureSize'), ['gen3d', 'retexture']);

  // the union is exactly the two sets: a knob in neither would be unreachable
  // from every operation, which is how a live parameter goes quietly dead
  assertEquals(
    [...new Set([...knobs('gen3d'), ...knobs('retexture')])].sort(),
    Object.keys(v.paramsSchema.properties as object).sort(),
  );
});

test('the narrowed schema is stable by identity, so core caches it once', async () => {
  // core compiles ajv validators keyed by schema IDENTITY (packages/core/params.ts) —
  // a fresh object per call would recompile the same schema on every job
  const cat = await loadCatalog();
  const t = cat.models.find((m) => m.id === 'trellis2-4b')!.versions[0];
  const generation = paramsSchemaFor(t, 'gen3d');
  assert(paramsSchemaFor(t, 'gen3d') === generation);
  assert(paramsSchemaFor(t, 'gen3d') !== paramsSchemaFor(t, 'retexture'));
  // a single-capability backend declares no sets and pays nothing: same object
  const unirig = cat.models.find((m) => m.id === 'unirig')!.versions[0];
  assert(paramsSchemaFor(unirig, 'rig') === unirig.paramsSchema);
  assertEquals(operationsAccepting(unirig, 'anything'), []);
});

test('a knob set that names an undescribed property is refused', () => {
  // the typo that would otherwise DELETE a parameter: the narrowed schema drops
  // what it does not find, so a misspelling silently removes the real knob
  const withSet = (keys: string[]) =>
    ModelCatalogSchema.safeParse({
      schemaVersion: 2,
      models: [toyEntry({
        versions: [toyVersion({
          paramsSchema: { type: 'object', properties: { seed: { type: 'integer' } } },
          operationParams: { rig: keys },
        })],
      })],
    });
  const bad = withSet(['sed']);
  assert(!bad.success);
  assert(
    JSON.stringify(bad.error.issues).includes('paramsSchema does not describe'),
    `message must name the cause: ${JSON.stringify(bad.error.issues)}`,
  );
  assert(withSet(['seed']).success, 'a described knob is admitted');
});

test('defaults for an operation the version cannot do are refused', () => {
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
