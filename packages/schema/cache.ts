/**
 * Cache (D-011): hash INPUTS, never pixels; bind to the immutable characterId.
 *
 * THE GUARANTEE: `displayName` can never enter a cache key. The schema is
 * strict (unknown keys rejected — so a smuggled displayName fails loudly) and
 * a compile-time assertion below keeps the type itself honest. Renaming a
 * character invalidates nothing.
 */
import { z } from 'zod';
import { CharacterIdSchema, Sha256Schema } from './identity.ts';

export const CacheKeyInputsSchema = z.strictObject({
  /** NEVER displayName */
  characterId: CharacterIdSchema,
  canonicalMeshSha256: Sha256Schema,
  /** incl. jointEdits + orientationFixes */
  rigStateHash: Sha256Schema,
  clipBindingHash: Sha256Schema,
  cameraPresetHash: Sha256Schema,
  stylePresetHash: Sha256Schema,
  rendererVersion: z.string().min(1),
  backend: z.strictObject({
    modelId: z.string().min(1),
    version: z.string().min(1),
    paramsHash: Sha256Schema,
  }),
});
export type CacheKeyInputs = z.output<typeof CacheKeyInputsSchema>;

// Compile-time guarantee: the CacheKeyInputs type has no displayName anywhere
// a rename could reach. If someone adds one, this line stops compiling.
type _AssertNoDisplayName = 'displayName' extends keyof CacheKeyInputs ? never : true;
const _assertNoDisplayName: _AssertNoDisplayName = true;
void _assertNoDisplayName;
