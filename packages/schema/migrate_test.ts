import { assert, assertEquals } from 'jsr:@std/assert@1';
import { parseWith } from './canonical.ts';
import { CharacterManifestSchema } from './character.ts';
import { migrateCharacterManifest, SCHEMA_VERSION } from './migrate.ts';

Deno.test('v1 character manifest migrates to current and validates', async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL('./fixtures/migrate/character.v1.json', import.meta.url)),
  );
  assertEquals(raw.schemaVersion, undefined, 'v1 fixture predates the version field');
  assertEquals(raw.mirroring, undefined, 'v1 fixture predates D-008 opt-in mirroring');

  const migrated = migrateCharacterManifest(raw);
  const manifest = parseWith(CharacterManifestSchema, migrated, 'migrated CharacterManifest');

  assertEquals(manifest.schemaVersion, SCHEMA_VERSION);
  assertEquals(manifest.mirroring, { enabled: false }, 'D-008: mirroring defaults OFF');
  assert(manifest.id === 'brave-knight');
});

Deno.test('migration is a no-op on current documents', async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL('./fixtures/valid/character-manifest.json', import.meta.url)),
  );
  const migrated = migrateCharacterManifest(raw);
  assertEquals(migrated, raw);
});
