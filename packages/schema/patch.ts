/**
 * Undo (law 7): every mutation is a journaled, reversible ManifestPatch with a
 * PRECOMPUTED inverse (audit item 7) — `spritebook undo` replays inverses, it
 * never recomputes them.
 *
 * Guards encoded here rather than left to convention:
 *  - immutable identity paths can never be patched (`/id`, `/characterId`,
 *    `/createdAt`, `/bakeId`, `/schemaVersion`)
 *  - `value` is required for add/replace and forbidden for remove
 *  - the inverse must have exactly one op per forward op (add<->remove,
 *    replace<->replace under RFC-6902 subset)
 */
import { z } from 'zod';
import { IsoTimeSchema } from './identity.ts';

export const IMMUTABLE_PATCH_PATHS = [
  '/id',
  '/characterId',
  '/createdAt',
  '/bakeId',
  '/schemaVersion',
] as const;

export const JsonPatchOpSchema = z
  .strictObject({
    op: z.enum(['add', 'remove', 'replace']),
    path: z.string().regex(/^\//, 'JSON Pointer paths start with "/"'),
    value: z.unknown().optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.op === 'add' || v.op === 'replace') && v.value === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `value is required for op '${v.op}'`,
      });
    }
    if (v.op === 'remove' && v.value !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: "value is forbidden for op 'remove'",
      });
    }
    const hit = IMMUTABLE_PATCH_PATHS.find((p) => v.path === p || v.path.startsWith(`${p}/`));
    if (hit) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: `${hit} is immutable and cannot be patched (identity split law)`,
      });
    }
  });
export type JsonPatchOp = z.output<typeof JsonPatchOpSchema>;

export const ManifestPatchSchema = z
  .strictObject({
    seq: z.int().nonnegative(),
    at: IsoTimeSchema,
    target: z.strictObject({
      kind: z.enum(['character', 'project']),
      id: z.string().min(1),
    }),
    op: z.array(JsonPatchOpSchema).min(1),
    /** precomputed at apply time — undo replays this verbatim */
    inverse: z.array(JsonPatchOpSchema).min(1),
    /** human label for the undo stack: "Nudge shoulder_L" */
    label: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.inverse.length !== v.op.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['inverse'],
        message: `inverse must contain exactly one op per forward op ` +
          `(got ${v.inverse.length} for ${v.op.length})`,
      });
    }
  });
export type ManifestPatch = z.output<typeof ManifestPatchSchema>;
