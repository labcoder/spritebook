/**
 * @spritebook/pack - MaxRects atlasing behind the parallel-layout law, the
 * per-frame input-hash cache, the BakeManifest writer, contact sheets, and the
 * bake orchestrator. The seam: a BakeJobSpec (plain data) in; a bake dir
 * (manifest + atlas pages + artifacts) + a JobEvent stream out. No GPU object
 * or pixel buffer crosses this API (D-004 discipline throughout).
 */
export * from './contracts.ts';
export {
  artifactKey,
  bakeKey,
  BlobCache,
  frameKey,
  predictInvalidation,
  rigForKey,
} from './cache.ts';
export { diffCacheInputs } from './plan.ts';
export { assembleManifest, frameGrid } from './manifest.ts';
export { DEFAULT_GAP_PX, DEFAULT_MAX_PAGE_SIZE_PX, packLayout } from './maxrects.ts';
export { assertRectIdentity, composePage, encodePagePng } from './atlas.ts';
export { assertRenderedPrefix, flipCellPng, flipPlaneH, mirrorPlan } from './mirror.ts';
export type { MirrorPlan } from './mirror.ts';
export { aov1x } from './aov1x.ts';
export { buildContactSheet } from './contactsheet.ts';
export { buildCacheInputs, BUNDLED_PACK, pivotFor, runBakeJob } from './bake.ts';
export type { BakeJobSpec, BakeProvenance, ClipBindingSpec } from './bake.ts';
