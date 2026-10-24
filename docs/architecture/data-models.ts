/**
 * SpriteBook data-model index.
 *
 * packages/schema is authoritative. These type-only exports replace the old
 * hand-written draft so the architecture reference cannot define a second shape.
 * Import application types and runtime validators from @spritebook/schema.
 *
 * Contract map (paths relative to this file):
 *   ../../packages/schema/identity.ts      immutable, validated IDs
 *   ../../packages/schema/character.ts     CharacterManifest, source/results/rig/clips
 *   ../../packages/schema/project.ts       project, camera and style presets
 *   ../../packages/schema/registry.ts      catalog, install receipts and exact pins
 *   ../../packages/schema/model-runtime.ts frozen runtime recipes and readiness receipts
 *   ../../packages/schema/sidecar.ts        authenticated local service and adapter jobs
 *   ../../packages/schema/rig.ts            skeletons, body fit, repair and motion-review reports
 *   ../../packages/schema/roster.ts         identity layers, attachments and canonical bodies
 *   ../../packages/schema/animpack.ts       animation packs, clips and provenance
 *   ../../packages/schema/bake.ts           BakeManifest, frame rects and parallel AOV pages
 *   ../../packages/schema/cache.ts          input-hash cache keys
 *   ../../packages/schema/jobs.ts           NDJSON JobEvent vocabulary
 *   ../../packages/schema/patch.ts          reversible manifest patches
 *   ../../packages/schema/batch.ts          roster/batch manifests and bake plans
 *   ../../packages/schema/prefs.ts          machine-local layout preferences
 *   ../../packages/schema/migrate.ts        document versions and character migrations
 *
 * Current versions: CharacterManifest 3; Project, BakeManifest and AnimPack 2.
 * ModelCatalog, RigSkeleton, roster and wire contracts version independently;
 * use each schema's gate rather than assuming one global version.
 *
 * Conventions: canonical glTF is +Y up, +Z front, meters, feet at Y=0.
 * Angles are degrees; times are seconds unless suffixed; hashes are SHA-256 hex.
 * characterId is immutable; displayName is mutable metadata and never a cache key.
 * ProjectPins.rendererVersion is reserved; the actual runtime/backend/adapter
 * render signature owns cache identity and is recorded in each BakeManifest.
 *
 * Workspace persistence and exact execution policy are documented in
 * workspace-persistence.md and execution-policy.md alongside this index.
 */
export type * from '../../packages/schema/mod.ts';
