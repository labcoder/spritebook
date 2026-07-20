/**
 * Generation contracts (P3-T2 second half): the image -> canonical textured
 * glb path, its provenance receipts, and the on-disk workspace they live in.
 *
 * ## The chain, and where truth lives
 *
 *   source image
 *     -> [gen3d adapter in the sidecar]  raw.glb   (backend output, unblessed)
 *     -> [texture substage, only when outputs.texture === false]
 *     -> [THE P1 BORDER: importToCanonical]        model.glb (canonical, D-012)
 *     -> GenerationResult receipt pinned to model.glb's sha256
 *
 * The receipt's `output.gltfSha256` pins the CANONICAL bytes, never the raw
 * backend output: the canonical form is what every downstream stage consumes,
 * so it is what provenance must be able to reproduce. `raw.glb` is kept beside
 * it because a backend bug and a border bug look identical from the canonical
 * side alone.
 *
 * ## Workspace layout (one directory per character)
 *
 *   <workspace>/
 *     character.json                  CharacterManifest, canonical bytes
 *     character.json.journal.ndjson   ManifestPatch lines (the P1-T3 journal —
 *     character.json.journal.cursor   so `undo` works on generation for free)
 *     source/<sha256>.<ext>           the source image, content-addressed
 *     results/<resultId>/raw.glb      what the backend emitted
 *     results/<resultId>/model.glb    canonical; gltfSha256 pins THIS
 *     results/<resultId>/preflight.json
 *     canonical/model.glb             the PICKED result (a copy, so every
 *                                     downstream verb has one stable path)
 *
 * Result ids are `r1`, `r2`, ... assigned in creation order and never reused;
 * a discarded result keeps its id and its files (receipts are append-only
 * history, not a live set).
 */
import { z } from 'zod';
import { CharacterIdSchema } from './identity.ts';

/** Files and dirs the workspace layout above is made of. */
export const MANIFEST_FILE = 'character.json';
export const SOURCE_DIR = 'source';
export const RESULTS_DIR = 'results';
export const CANONICAL_DIR = 'canonical';
export const CANONICAL_MODEL = 'model.glb';
export const RAW_MODEL = 'raw.glb';
/** what the border wrote next to a result */
export const RESULT_PREFLIGHT = 'preflight.json';

/** `r1`, `r2`, ... — creation order, never reused. */
export const ResultIdSchema = z.string().regex(/^r[1-9][0-9]*$/);

/**
 * A gen3d adapter's job params, as core sends them. Backend-specific knobs
 * ride in `params` and are validated against the entry's paramsSchema BEFORE
 * the request exists; these four are the contract every gen3d adapter honors.
 */
export const GenAdapterParamsSchema = z.strictObject({
  /** the CUT-OUT RGBA image (SpriteBook does background removal itself, so a
   * backend's own matting stage is never required — see the trellis2-4b entry
   * notes for why that mattered) */
  imagePath: z.string().min(1),
  /** adapter writes raw.glb (and any textures) here */
  outDir: z.string().min(1),
  /** recorded in the receipt; the same seed must reproduce the same output */
  seed: z.int().nonnegative(),
  /** where the registry installed this version's weights */
  modelDir: z.string().min(1),
});
export type GenAdapterParams = z.output<typeof GenAdapterParamsSchema>;

/** Artifact kinds a gen3d adapter emits (the raw mesh is mandatory). */
export const GEN_ARTIFACT_MESH = 'mesh-raw';
/** Emitted by the texture substage when a geometry-only backend needs one. */
export const GEN_ARTIFACT_TEXTURE = 'texture';

/**
 * One generation request at the core seam. `params` are the backend's own
 * knobs; `seed` is hoisted out of them because provenance depends on it and
 * every backend has one.
 */
export const GenJobSpecSchema = z.strictObject({
  jobId: z.string().min(1),
  characterId: CharacterIdSchema,
  /** the workspace dir (created if absent) */
  workspace: z.string().min(1),
  /** cut-out RGBA source image — `spritebook prep` produces one */
  imagePath: z.string().min(1),
  modelId: z.string().min(1),
  /** omitted -> the highest installed version */
  version: z.string().optional(),
  seed: z.int().nonnegative(),
  params: z.record(z.string(), z.unknown()),
  /** target standing height handed to the border (D-012 scale convention) */
  declaredHeightM: z.number().positive().optional(),
});
export type GenJobSpec = z.output<typeof GenJobSpecSchema>;

/**
 * Job-time VRAM preflight — the HARD gate the install-time check deferred to
 * (sidecar-vram: fail before loading weights, with an honest message, not an
 * OOM twenty seconds in). `detectedGb: null` means no GPU could be measured:
 * that WARNS rather than blocks, because a machine we cannot measure is not
 * the same as a machine we know is too small.
 */
export type VramPreflight =
  | { ok: true; status: 'ok' | 'unknown' | 'not-required'; warn?: string }
  | { ok: false; code: 'vram-insufficient'; message: string };

export function preflightVram(
  minGb: number | undefined,
  detectedGb: number | null,
): VramPreflight {
  if (minGb === undefined) return { ok: true, status: 'not-required' };
  if (detectedGb === null) {
    return {
      ok: true,
      status: 'unknown',
      warn: `This backend's measured minimum is ${minGb} GiB of VRAM and no GPU could be ` +
        `measured on this machine. Running anyway; an out-of-memory failure here is expected, ` +
        `not a bug.`,
    };
  }
  if (detectedGb < minGb) {
    return {
      ok: false,
      code: 'vram-insufficient',
      message: `This backend needs ${minGb} GiB of VRAM (measured) and this machine has ` +
        `${detectedGb} GiB. Refusing before loading weights - a smaller image or a lighter ` +
        `backend is the fix; \`spritebook models list\` shows what each one needs.`,
    };
  }
  return { ok: true, status: 'ok' };
}
