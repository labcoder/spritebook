/**
 * @spritebook/pack - MaxRects atlasing behind the parallel-layout law, the
 * per-frame input-hash cache, the BakeManifest writer, contact sheets, and the
 * bake orchestrator. The seam: a BakeJobSpec (plain data) in; a bake dir
 * (manifest + atlas pages + artifacts) + a JobEvent stream out. No GPU object
 * or pixel buffer crosses this API (D-004 discipline throughout).
 */
export * from './contracts.ts';
export { artifactKey, bakeKey, BlobCache, frameKey, predictInvalidation } from './cache.ts';
export { assembleManifest, frameGrid } from './manifest.ts';
export { DEFAULT_GAP_PX, DEFAULT_MAX_PAGE_SIZE_PX, packLayout } from './maxrects.ts';
export { assertRectIdentity, composePage, encodePagePng } from './atlas.ts';
export { aov1x } from './aov1x.ts';
export { buildContactSheet } from './contactsheet.ts';
export { buildCacheInputs, pivotFor, runBakeJob } from './bake.ts';
export type { BakeJobSpec } from './bake.ts';
