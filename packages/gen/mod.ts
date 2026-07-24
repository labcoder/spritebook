/**
 * @spritebook/gen - the generation pipeline: image -> backend -> THE BORDER ->
 * canonical textured glb + a receipt that can reproduce it.
 *
 * Sits beside @spritebook/pack the way `gen` sits beside `bake` in the verb
 * surface: pack orchestrates render->style->atlas, gen orchestrates
 * registry->sidecar->border->manifest. Both speak only file paths and
 * JobEvents across their seams (D-004).
 */
export { runGenJob } from './gen.ts';
export type { GenJobOptions } from './gen.ts';
export { runPickJob } from './pick.ts';
export type { PickJobOptions } from './pick.ts';
export { reprojectTexture } from './reproject.ts';
export type { ReprojectOptions, ReprojectStats } from './reproject.ts';
export {
  applyAttachments,
  applyBoneMask,
  compositeDecals,
  REGION_WEIGHT_FLOOR,
  sidePartnerRegion,
} from './identity.ts';
export type {
  ApplyAttachmentsOptions,
  ApplyBoneMaskOptions,
  AttachmentLanding,
  AttachmentReport,
  BoneMaskReplacement,
  BoneMaskReport,
  CompositeDecalsOptions,
  DecalLanding,
  DecalReport,
  SocketSpec,
} from './identity.ts';
