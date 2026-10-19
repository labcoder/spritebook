/**
 * "What is stale, and why" — the per-field form of predictInvalidation.
 *
 * `predictInvalidation` answers the question the CACHE asks (which frame keys
 * change), and its answer is all-or-none because every frame key embeds the
 * whole recipe. That is the correct answer and a useless explanation: a user
 * looking at "4800 frames will re-render" cannot tell whether they changed a
 * style knob, upgraded their GPU driver, or re-picked a mesh.
 *
 * This module answers the question the USER asks, off the same two documents:
 * which FIELD of the recipe moved, said in the language of the thing they did.
 * It renders nothing, reads nothing, and hashes nothing — both sides are
 * already-computed CacheKeyInputs, so a plan over a hundred characters costs a
 * hundred manifest reads and one mesh hash each.
 *
 * The field order below is the order reasons are reported in, and it is not
 * alphabetical: it runs from "you changed the character" to "your machine
 * changed", because when several fields move at once the first one is almost
 * always the one the user did on purpose.
 */
import type { CacheKeyInputs } from '@spritebook/schema';
import type { StaleField, StaleReason } from '@spritebook/schema';

/** Enough hash to see a flip, short enough to sit in a terminal column. */
function shorten(v: string): string {
  return /^[0-9a-f]{64}$/.test(v) ? v.slice(0, 8) : v;
}

/**
 * What each field means to the person who changed it.
 *
 * `rigStateHash` used to name acceptance here, because pressing Accept moved
 * the key without moving a pixel. D-031 took `accepted` out of the hash
 * instead — it was the honest fix, not the honest warning — so the reason no
 * longer has to apologise for it.
 */
const REASONS: Record<StaleField, (from: string, to: string) => string> = {
  characterId: (from, to) =>
    `this bake belongs to character "${from}", not "${to}" — a bake directory cannot be ` +
    `reused across characters (every cache key binds to the id, D-011)`,
  canonicalMeshSha256: () =>
    'the canonical mesh changed — a different candidate was picked, or the mesh was regenerated',
  rigStateHash: () =>
    'the rig changed — a re-run, joint edits, orientation fixes, a different track, or a bone ' +
    'mask. Accepting a rig is NOT in this hash (D-031), so this is a real change to the skeleton',
  clipBindingHash: () =>
    'the animation changed — which clips are enabled, their frames/speed/hold, or the clip bytes ' +
    'in the pack itself',
  cameraPresetHash: () =>
    'the camera changed — elevation, direction count, pixels-per-meter, cell size, padding, or ' +
    'the mirroring setting (mirroring rides the camera hash because it decides how directions ' +
    'are produced)',
  stylePresetHash: () =>
    'the style changed — a different preset, or an override on colors, outline, dithering, or ' +
    'supersampling',
  lightRigHash: () =>
    'the light rig changed — key direction or ambient floor. Two bakes can share a camera exactly ' +
    'and differ in every pixel, which is why this is its own input',
  rendererVersion: (from, to) =>
    `the renderer or the GPU adapter changed (${from} → ${to}) — a different card, a runtime ` +
    'upgrade, or a change to the render pipeline itself',
  backend: () => 'a different generation backend, version, or parameter set produced this mesh',
};

/** Reported in this order when several move at once; see the module note. */
const FIELD_ORDER: StaleField[] = [
  'characterId',
  'canonicalMeshSha256',
  'rigStateHash',
  'clipBindingHash',
  'stylePresetHash',
  'cameraPresetHash',
  'lightRigHash',
  'backend',
  'rendererVersion',
];

/** The comparable form of a field — `backend` is three sub-fields as one. */
function valueOf(inputs: CacheKeyInputs, field: StaleField): string {
  if (field !== 'backend') return inputs[field];
  const b = inputs.backend;
  return `${b.modelId}@${b.version}#${shorten(b.paramsHash)}`;
}

/**
 * Every recipe field that differs between two bakes, newest-intent first.
 *
 * An empty result means the recipes are identical and a re-bake would produce
 * the same pixels from cache — the same condition `predictInvalidation`
 * reports as an empty frame set, reached without touching the frame list.
 */
export function diffCacheInputs(
  previous: CacheKeyInputs,
  next: CacheKeyInputs,
): StaleReason[] {
  const out: StaleReason[] = [];
  for (const field of FIELD_ORDER) {
    const from = valueOf(previous, field);
    const to = valueOf(next, field);
    if (from === to) continue;
    out.push({ field, why: REASONS[field](shorten(from), shorten(to)), from, to });
  }
  return out;
}
