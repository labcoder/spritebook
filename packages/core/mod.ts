/**
 * @spritebook/core - queue, events, journal/undo, cache, orchestration.
 *
 * P1-T3: the core spine against stub executors — the NDJSON contract
 * (validated at the EventBus choke point), a concurrency-limited queue with
 * cancel + retry-on-retryable, the ManifestPatch journal with precomputed
 * inverses (undo/redo), and the input-hash cache (D-011).
 */
export * from './events.ts';
export * from './queue.ts';
export * from './journal.ts';
export * from './workspace.ts';
export * from './receipts.ts';
export * from './roster.ts';
export * from './vramlease.ts';
export * from './cache.ts';
export * from './presets.ts';
export * from './stub-bake.ts';
export * from './sidecar.ts';
export * from './params.ts';
export * from './oklab.ts';

export {
  commitManifest,
  moveManifestCursor,
  withManifestLock,
  withManifestWrite,
  workspaceJob,
} from './persistence.ts';

export * from './queries.ts';
