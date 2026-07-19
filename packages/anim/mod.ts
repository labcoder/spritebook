/**
 * @spritebook/anim - animation packs, the humanoid retarget profile, clip
 * sampling, and the poses artifact the render seam plays (P3-T1). Everything
 * crosses package boundaries as plain data and file paths; the retarget runs
 * ONCE in core (D-006) and both previews and bakes consume its output.
 *
 * NOTE: retarget/profile/sample exports join this surface as their modules
 * land in-phase; contracts + pack tooling are stable now.
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
