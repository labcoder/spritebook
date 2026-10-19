import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { assert, assertEquals, assertThrows } from '@std/assert';
import { parseWith } from './dist/canonical.js';
import { CharacterManifestSchema } from './dist/character.js';
import {
  CHARACTER_SCHEMA_VERSION,
  migrateCharacterManifest,
  SCHEMA_VERSION,
} from './dist/migrate.js';

test('v1 character manifest walks every step and validates', async () => {
  const raw = JSON.parse(
    await fs.readFile(new URL('./fixtures/migrate/character.v1.json', import.meta.url), 'utf8'),
  );
  assertEquals(raw.schemaVersion, undefined, 'v1 fixture predates the version field');
  assertEquals(raw.mirroring, undefined, 'v1 fixture predates D-008 opt-in mirroring');
  assert(raw.preflight !== undefined, 'v1 fixture carries the block v3 drops');

  const migrated = migrateCharacterManifest(raw);
  const manifest = parseWith(CharacterManifestSchema, migrated, 'migrated CharacterManifest');

  assertEquals(manifest.schemaVersion, CHARACTER_SCHEMA_VERSION);
  assertEquals(manifest.mirroring, { enabled: false }, 'v2 (D-008): mirroring defaults OFF');
  assertEquals(migrated.preflight, undefined, 'v3 (D-029): the manifest copy is gone');
  assert(manifest.id === 'brave-knight');
});

test('a v2 document carrying preflight upgrades rather than being refused', () => {
  // The realistic case: a workspace created before this build. `schemaVersion:
  // z.literal(3)` would REJECT it outright, which is why the loaders migrate
  // first — a valid v2 manifest must never become an unopenable workspace.
  const v2 = {
    schemaVersion: 2,
    id: 'brave-knight',
    displayName: 'Brave Knight',
    createdAt: '2026-07-12T00:00:00Z',
    source: { kind: 'image', originalFilename: 'knight.png', sha256: 'a'.repeat(64) },
    preflight: {
      at: '2026-07-12T00:00:00Z',
      checks: [{ id: 'cutout', status: 'ok', message: 'Background removed cleanly' }],
    },
    generation: { results: [] },
    mirroring: { enabled: false },
  };
  const migrated = migrateCharacterManifest(v2);
  assertEquals(migrated.preflight, undefined);
  const manifest = parseWith(CharacterManifestSchema, migrated, 'migrated v2 CharacterManifest');
  assertEquals(manifest.schemaVersion, 3);
  assertEquals(manifest.displayName, 'Brave Knight', 'everything else survives untouched');
});

test('migration is a no-op on current documents', async () => {
  const raw = JSON.parse(
    await fs.readFile(new URL('./fixtures/valid/character-manifest.json', import.meta.url), 'utf8'),
  );
  const migrated = migrateCharacterManifest(raw);
  assertEquals(migrated, raw);
});

test('the character version is its own, and has left the global behind', () => {
  // A regression guard with teeth: the two constants used to be one, so any
  // future CharacterManifest change must move CHARACTER_SCHEMA_VERSION alone.
  // Re-pointing the schema at SCHEMA_VERSION would silently un-version four
  // other document types along with it.
  assertEquals(CHARACTER_SCHEMA_VERSION, 3);
  assertEquals(SCHEMA_VERSION, 2, 'Project, BakeManifest and AnimPack stay at 2');
  assertThrows(
    () => parseWith(CharacterManifestSchema, { schemaVersion: SCHEMA_VERSION }, 'v2 manifest'),
    Error,
    'schemaVersion',
  );
});
