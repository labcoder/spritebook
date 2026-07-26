/**
 * Schema versioning + migrations. Persisted documents (CharacterManifest,
 * Project, BakeManifest) carry `schemaVersion`.
 *
 * NOT WIRED UP YET. The intent is that loaders call migrate* before validating,
 * but nothing does: core/workspace.ts and core/receipts.ts parse straight
 * against the schema, and `schemaVersion: z.literal(SCHEMA_VERSION)` rejects an
 * older document outright rather than upgrading it. BakeManifest has no
 * migration table at all. So this machinery is exercised only by its own tests
 * — real enough to build on, but do not read the presence of `migrateX` as
 * evidence that old documents load.
 *
 * ## Why CharacterManifest versions on its own
 *
 * One global constant governed four unrelated document types, so any change to
 * one of them forced a version bump on all four — including AnimPack, whose
 * committed bundle is rebuildable only from a local UAL download. Three schemas
 * (registry, roster, rig) had already opted out with their own literals rather
 * than pay that. CharacterManifest is the document that actually migrates, so
 * it gets CHARACTER_SCHEMA_VERSION and the global stays where it is; a
 * BakeManifest change will want the same treatment when it comes.
 *
 * History:
 *  v1 — hypothetical pre-D-008 shape: CharacterManifest had no `mirroring`
 *       field (mirroring was implicit-on).
 *  v2 — explicit opt-in `mirroring: { enabled: boolean }` (D-008); documents
 *       carry schemaVersion. Still the version of Project, BakeManifest and
 *       AnimPack.
 *  v3 — CharacterManifest only: `preflight` removed (D-029). The report lives
 *       at results/<resultId>/preflight.json, and a second copy in the manifest
 *       was two things that could disagree about the same import. Nothing ever
 *       read the manifest's copy.
 */

export const SCHEMA_VERSION = 2 as const;

/**
 * CharacterManifest's own version — see the note above. Diverges from
 * SCHEMA_VERSION as of v3; the two are not interchangeable, and a document
 * validating against one says nothing about the other.
 */
export const CHARACTER_SCHEMA_VERSION = 3 as const;

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

/**
 * v2 -> v3: drop `preflight` (D-029).
 *
 * Dropped, not moved: the authoritative report is already on disk at
 * results/<resultId>/preflight.json, written by the import that produced it.
 * Rewriting it out of the manifest loses nothing, and a migration that tried to
 * WRITE that file would be a migration doing IO.
 */
function characterV2toV3(doc: Raw): Raw {
  const { preflight: _dropped, ...rest } = doc;
  return { ...rest, schemaVersion: 3 };
}

const CHARACTER_MIGRATIONS: Record<number, (doc: Raw) => Raw> = {
  1: characterV1toV2,
  2: characterV2toV3,
};

/**
 * Bring a raw character-manifest document to the current schema version.
 * Returns a NEW object; callers validate the result with
 * CharacterManifestSchema afterwards.
 */
export function migrateCharacterManifest(data: unknown): Raw {
  let doc = asRaw(data, 'CharacterManifest');
  let version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 1;
  while (version < CHARACTER_SCHEMA_VERSION) {
    const step = CHARACTER_MIGRATIONS[version];
    if (!step) throw new Error(`no migration from CharacterManifest schemaVersion ${version}`);
    doc = step(doc);
    version = doc.schemaVersion as number;
  }
  if (version > CHARACTER_SCHEMA_VERSION) {
    throw new Error(
      `CharacterManifest schemaVersion ${version} is newer than this build ` +
        `(${CHARACTER_SCHEMA_VERSION})`,
    );
  }
  return doc;
}
