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
export * from './cache.ts';
export * from './stub-bake.ts';
