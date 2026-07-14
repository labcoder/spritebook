/**
 * Schema versioning + migrations. Persisted documents (CharacterManifest,
 * Project, BakeManifest) carry `schemaVersion`; loaders call migrate* before
 * validating, so old manifests upgrade transparently and deterministically.
 *
 * History:
 *  v1 — hypothetical pre-D-008 shape: CharacterManifest had no `mirroring`
 *       field (mirroring was implicit-on).
 *  v2 — current: explicit opt-in `mirroring: { enabled: boolean }` (D-008);
 *       documents carry schemaVersion.
 */

export const SCHEMA_VERSION = 2 as const;

type Raw = Record<string, unknown>;

function asRaw(data: unknown, what: string): Raw {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`cannot migrate ${what}: expected an object`);
  }
  return { ...(data as Raw) };
}

/** v1 -> v2: mirroring becomes explicit opt-in, default OFF (D-008). */
function characterV1toV2(doc: Raw): Raw {
  return { ...doc, mirroring: doc.mirroring ?? { enabled: false }, schemaVersion: 2 };
}

const CHARACTER_MIGRATIONS: Record<number, (doc: Raw) => Raw> = {
  1: characterV1toV2,
};

/**
 * Bring a raw character-manifest document to the current schema version.
 * Returns a NEW object; callers validate the result with
 * CharacterManifestSchema afterwards.
 */
export function migrateCharacterManifest(data: unknown): Raw {
  let doc = asRaw(data, 'CharacterManifest');
  let version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 1;
  while (version < SCHEMA_VERSION) {
    const step = CHARACTER_MIGRATIONS[version];
    if (!step) throw new Error(`no migration from CharacterManifest schemaVersion ${version}`);
    doc = step(doc);
    version = doc.schemaVersion as number;
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `CharacterManifest schemaVersion ${version} is newer than this build (${SCHEMA_VERSION})`,
    );
  }
  return doc;
}
