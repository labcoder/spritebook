/**
 * @spritebook/schema - the single typed truth with runtime validation.
 *
 * Implements docs/architecture/data-models.ts v0.2 (P1-T2). Validation is
 * zod 4 (see docs/dependencies.md); every persisted document serializes via
 * canonicalJson and round-trips byte-identically.
 */
export * from './canonical.ts';
export * from './identity.ts';
export * from './registry.ts';
export * from './sidecar.ts';
export * from './project.ts';
export * from './character.ts';
export * from './animpack.ts';
export * from './bake.ts';
export * from './cache.ts';
export * from './jobs.ts';
export * from './patch.ts';
export * from './prefs.ts';
export * from './migrate.ts';
