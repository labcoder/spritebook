/**
 * Animation pack manifest (P3-T1; D-009: packs are catalog DATA, never
 * hardcoded integrations; D-013: bundle CC0 only, user imports flagged
 * non-redistributable and never bundled). A pack on disk is a directory:
 * `pack.json` (this schema) + `clips/<clipId>.glb` (one skeleton+animation per
 * file). The bundled UAL pack is BUILT from the maintainer's local download by
 * `packages/anim` tooling; its CC0 license is what makes the converted output
 * committable.
 */
import { z } from 'zod';
import { SCHEMA_VERSION } from './migrate.ts';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const AnimClipMetaSchema = z.strictObject({
  /** file stem under clips/ — `clips/<id>.glb` */
  id: slug,
  /** the animation's display / source name (e.g. "Walk_Loop") */
  name: z.string().min(1),
  /** one broad bucket for browsing (locomotion, idle, combat, pose, ...) */
  category: z.string().min(1),
  /** free-form search tags (`spritebook anim --list --tag <t>`) */
  tags: z.array(z.string().min(1)),
  durationS: z.number().positive(),
  loop: z.boolean(),
});
export type AnimClipMeta = z.output<typeof AnimClipMetaSchema>;

export const AnimPackSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: slug,
  name: z.string().min(1),
  version: z.string().min(1),
  /** SPDX-ish license id of the CLIP DATA (e.g. "CC0-1.0") */
  license: z.string().min(1),
  /** D-013: personal imports (e.g. Mixamo) are false and are never bundled */
  redistributable: z.boolean(),
  /** provenance: where the source assets came from */
  source: z.string().min(1),
  /** the skeleton convention every clip in the pack targets */
  skeleton: z.literal('ual-humanoid'),
  clips: z.array(AnimClipMetaSchema).min(1),
});
export type AnimPack = z.output<typeof AnimPackSchema>;
