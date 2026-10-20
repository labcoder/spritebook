/**
 * @spritebook/schema - the single typed truth with runtime validation.
 *
 * Defines the contracts indexed by docs/architecture/data-models.ts. Validation is
 * zod 4 (see docs/dependencies.md); every persisted document serializes via
 * canonicalJson and round-trips byte-identically.
 */
export * from './canonical.ts';
export * from './identity.ts';
export * from './registry.ts';
export * from './model-runtime.ts';
export * from './sidecar.ts';
export * from './gen.ts';
export * from './rig.ts';
export * from './roster.ts';
export * from './project.ts';
export * from './character.ts';
export * from './animpack.ts';
export * from './bake.ts';
export * from './batch.ts';
export * from './cache.ts';
export * from './jobs.ts';
export * from './patch.ts';
export * from './prefs.ts';
export * from './migrate.ts';
