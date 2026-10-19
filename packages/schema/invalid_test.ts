import { promises as fs } from 'node:fs';
import { test } from 'node:test';
/**
 * T2 acceptance: invalid documents fail with ACTIONABLE messages — the error
 * must name the offending path and say what was expected, never a stack trace.
 */
import { assert, assertThrows } from '@std/assert';
import type { z } from 'zod';
import { parseWith, SchemaError } from './dist/canonical.js';
import { CharacterIdSchema } from './dist/identity.js';
import { CacheKeyInputsSchema } from './dist/cache.js';
import { JsonPatchOpSchema, ManifestPatchSchema } from './dist/patch.js';
import { CameraOverridesSchema, StylePresetSchema } from './dist/project.js';
import { CharacterManifestSchema } from './dist/character.js';
import { JobEventSchema } from './dist/jobs.js';
import { migrateCharacterManifest } from './dist/migrate.js';

function expectFailure(schema: z.ZodType, data: unknown, what: string, ...fragments: string[]) {
  const err = assertThrows(() => parseWith(schema, data, what), SchemaError);
  for (const f of fragments) {
    assert(err.message.includes(f), `expected message to include "${f}", got:\n${err.message}`);
  }
}

test('characterId rejects non-slug values with the rule spelled out', () => {
  expectFailure(CharacterIdSchema, 'Brave Knight!', 'characterId', 'lowercase slug');
  expectFailure(CharacterIdSchema, 'x', 'characterId', 'lowercase slug'); // too short
});

test('CacheKeyInputs rejects a smuggled displayName (strict object)', () => {
  expectFailure(
    CacheKeyInputsSchema,
    {
      characterId: 'brave-knight',
      displayName: 'Brave Knight',
      canonicalMeshSha256: 'b'.repeat(64),
      rigStateHash: 'c'.repeat(64),
      clipBindingHash: 'd'.repeat(64),
      cameraPresetHash: 'e'.repeat(64),
      stylePresetHash: 'f'.repeat(64),
      rendererVersion: '0.1.0',
      backend: { modelId: 'pixal3d', version: '1.2', paramsHash: '0'.repeat(64) },
    },
    'CacheKeyInputs',
    'displayName',
  );
});

test('patches cannot touch immutable identity paths', () => {
  expectFailure(
    JsonPatchOpSchema,
    { op: 'replace', path: '/id', value: 'new-name' },
    'JsonPatchOp',
    'immutable',
  );
  expectFailure(
    JsonPatchOpSchema,
    { op: 'remove', path: '/createdAt' },
    'JsonPatchOp',
    'immutable',
  );
});

test('patch ops: value required for add/replace, forbidden for remove', () => {
  expectFailure(
    JsonPatchOpSchema,
    { op: 'replace', path: '/displayName' },
    'JsonPatchOp',
    "value is required for op 'replace'",
  );
  expectFailure(
    JsonPatchOpSchema,
    { op: 'remove', path: '/notes', value: 1 },
    'JsonPatchOp',
    "value is forbidden for op 'remove'",
  );
});

test('ManifestPatch requires a 1:1 precomputed inverse', () => {
  expectFailure(
    ManifestPatchSchema,
    {
      seq: 1,
      at: '2026-07-12T00:00:00Z',
      target: { kind: 'character', id: 'brave-knight' },
      op: [
        { op: 'replace', path: '/displayName', value: 'A' },
        { op: 'replace', path: '/look/stylePresetId', value: 'cel-2' },
      ],
      inverse: [{ op: 'replace', path: '/displayName', value: 'B' }],
      label: 'two edits',
    },
    'ManifestPatch',
    'inverse',
    'one op per forward op',
  );
});

test("StylePreset: alpha '1bit' without cutoff is actionable", () => {
  expectFailure(
    StylePresetSchema,
    {
      id: 'cel-2',
      mode: 'cel',
      temporal: { superSample: 1, clusterVote: false, paletteHysteresisEps: 0, texelSnap: false },
      passes: ['lit'],
      alpha: { mode: '1bit', bleedPx: 2 },
    },
    'StylePreset',
    'cutoff',
    "'1bit'",
  );
});

test("StylePreset: passes must include 'lit' (parallel-layout law)", () => {
  expectFailure(
    StylePresetSchema,
    {
      id: 'cel-2',
      mode: 'cel',
      temporal: { superSample: 1, clusterVote: false, paletteHysteresisEps: 0, texelSnap: false },
      passes: ['normal'],
      alpha: { mode: 'soft', bleedPx: 2 },
    },
    'StylePreset',
    "must include 'lit'",
  );
});

test('StylePreset: a fixed palette cannot exceed maxColors', () => {
  // buildPalette hands a fixed palette straight to paletteFromHex and never
  // consults maxColors, so 40 hex colours with maxColors 8 painted with 40 —
  // a ceiling the user set and the pipeline ignored.
  const base = {
    id: 'fixed',
    mode: 'pixel' as const,
    temporal: { superSample: 1, clusterVote: false, paletteHysteresisEps: 0, texelSnap: true },
    passes: ['lit'],
    alpha: { mode: 'soft' as const, bleedPx: 2 },
  };
  const hex = (n: number) =>
    Array.from({ length: n }, (_, i) => `#${i.toString(16).padStart(6, '0')}`);
  expectFailure(
    StylePresetSchema,
    {
      ...base,
      quantize: { palette: hex(40), maxColors: 8, space: 'oklab', dither: { kind: 'none' } },
    },
    'StylePreset',
    'exceeds maxColors',
  );
  // equal is fine, and so is an adaptive palette (maxColors is its budget)
  parseWith(
    StylePresetSchema,
    {
      ...base,
      quantize: { palette: hex(8), maxColors: 8, space: 'oklab', dither: { kind: 'none' } },
    },
    'StylePreset',
  );
  parseWith(
    StylePresetSchema,
    {
      ...base,
      quantize: { palette: 'adaptive', maxColors: 8, space: 'oklab', dither: { kind: 'none' } },
    },
    'StylePreset',
  );
});

test('CameraOverrides: every field optional, but each still judged', () => {
  // the whole point of a partial: a character overriding one control must not
  // have to restate the other six
  parseWith(CameraOverridesSchema, {}, 'CameraOverrides');
  parseWith(CameraOverridesSchema, { directions: 16 }, 'CameraOverrides');
  // ...and "optional" is not "unchecked". These are the same refusals the full
  // preset makes, and a hand-edited manifest is exactly where they show up.
  expectFailure(CameraOverridesSchema, { elevationDeg: 90 }, 'CameraOverrides', 'elevationDeg');
  expectFailure(CameraOverridesSchema, { directions: 5 }, 'CameraOverrides', 'directions');
  expectFailure(CameraOverridesSchema, { pixelsPerMeter: 0 }, 'CameraOverrides', 'pixelsPerMeter');
  expectFailure(CameraOverridesSchema, { cellPx: { w: 64 } }, 'CameraOverrides', 'h');
});

test('CameraOverrides cannot rename the preset it refines', () => {
  // `id` is omitted on purpose (D-029): an override refines a preset, and the
  // resolved camera keeps the preset's id so a bake manifest can still say
  // where its framing came from. Accepting `id` here would let a character
  // record framing under a name no table can resolve — the exact defect
  // `cli-e30x8` was.
  expectFailure(CameraOverridesSchema, { id: 'my-camera' }, 'CameraOverrides', 'id');
  expectFailure(CameraOverridesSchema, { elevation: 30 }, 'CameraOverrides', 'elevation');
});

test('a result cannot derive from a parent that is not there', async () => {
  const fixture = JSON.parse(
    await fs.readFile(new URL('./fixtures/valid/character-manifest.json', import.meta.url), 'utf8'),
  ) as { generation: { results: { id: string; derivedFrom?: string }[] } };
  const withResults = (results: unknown[]) => ({
    ...fixture,
    generation: { ...fixture.generation, results },
  });
  const [r1, r2] = fixture.generation.results;
  assert(r2.derivedFrom === r1.id, 'the fixture exercises lineage');

  // dangling: it READS as an answer and is not one. Results are append-only, so
  // a live reference can only be orphaned by something writing the file by hand.
  expectFailure(
    CharacterManifestSchema,
    withResults([r1, { ...r2, derivedFrom: 'r9' }]),
    'CharacterManifest',
    'derivedFrom',
    'not in this manifest',
  );
  expectFailure(
    CharacterManifestSchema,
    withResults([r1, { ...r2, derivedFrom: r2.id }]),
    'CharacterManifest',
    'derives from itself',
  );
  // a DISCARDED parent is still a parent: receipts are history, not a live set,
  // and the lineage of a result you rejected is the useful part of the record
  parseWith(
    CharacterManifestSchema,
    withResults([{ ...r1, discarded: true }, r2]),
    'CharacterManifest',
  );
  // and having no parent at all stays the ordinary case
  parseWith(CharacterManifestSchema, withResults([r1]), 'CharacterManifest');
});

test('JobEvent rejects unknown discriminants and bad timestamps', () => {
  expectFailure(
    JobEventSchema,
    { t: 'finished', jobId: 'job-1', at: '2026-07-12T00:00:00Z' },
    'JobEvent',
    't',
  );
  expectFailure(JobEventSchema, { t: 'queued', jobId: 'job-1', at: 'yesterday' }, 'JobEvent', 'at');
});

test('migration refuses documents newer than this build', () => {
  const err = assertThrows(() =>
    migrateCharacterManifest({ schemaVersion: 99, id: 'brave-knight' }),
  );
  assert((err as Error).message.includes('newer than this build'));
});
