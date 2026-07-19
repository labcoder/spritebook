/**
 * @spritebook/anim - animation packs, the humanoid retarget profile, clip
 * sampling, and the poses artifact the render seam plays (P3-T1). Everything
 * crosses package boundaries as plain data and file paths; the retarget runs
 * ONCE in core (D-006) and both previews and bakes consume its output.
 */
export * from './contracts.ts';
export {
  buildPack,
  clipCategory,
  clipTags,
  importPack,
  listClips,
  loadPack,
  toClipId,
} from './pack.ts';
export type { AnimPackMeta, BuildPackOptions } from './pack.ts';
export { loadClip, loadSkeletonRest, loadSkeletonRestFromFile, UAL_HUMANOID } from './profile.ts';
export { loadPackClip } from './pack.ts';
export { retargetClip } from './retarget.ts';
export { addClipToDocument, writePreviewGlb } from './preview.ts';
export { frameTimes, readPoses, sampleClip, writePoses } from './sample.ts';
export type { SampledPoses, SampleSpec } from './sample.ts';
