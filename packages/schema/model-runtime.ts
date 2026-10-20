import { z } from 'zod';

const relativePath = z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/+-]+$/);

/** App-owned recipes describe external model environments, never app-bundled CUDA stacks. */
export const ModelRuntimeRecipeSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  platform: z.literal('win32-x64'),
  project: relativePath,
  extra: z.string().regex(/^[a-z0-9-]+$/).optional(),
  sources: z.array(z.strictObject({
    url: z.url(),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    path: relativePath,
    zip: z.boolean(),
  })).min(1),
  prepare: z.strictObject({ script: relativePath, source: relativePath }).optional(),
  check: relativePath,
  environment: z.record(z.string().regex(/^SPRITEBOOK_[A-Z0-9_]+$/), relativePath),
  notes: z.string().min(1),
});
export type ModelRuntimeRecipe = z.output<typeof ModelRuntimeRecipeSchema>;

export const ModelRuntimeReceiptSchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  preparedAt: z.iso.datetime(),
  files: z.record(relativePath, z.string().regex(/^[a-f0-9]{64}$/)).refine(
    (files) => Object.keys(files).length > 0,
    'Prepared source hashes are required',
  ),
});
