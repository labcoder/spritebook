/**
 * Track A contracts (P3-T4): the canonical body, the roster fit, the identity
 * layer, and the mirroring rule.
 *
 * ## Why Track A exists
 *
 * Track B (P3-T3) predicts a skeleton for ANY topology, which is the right
 * answer for one weird creature and the wrong answer for a hundred humanoids:
 * it costs ~70 s and a 17 GiB GPU per character, and every rig is subtly
 * different, so nothing is shareable. Track A inverts that — ONE canonical
 * rigged humanoid body, fitted to each generated mesh, so the skeleton, the UV
 * layout, and the animation bindings are IDENTICAL across the roster. That is
 * what makes palette swaps, shared atlases, and hundred-character rosters
 * tractable, and it needs no GPU at all.
 *
 * Identity does not come from the skeleton then; it comes from the surface:
 * textures, UV-space decals, socketed attachments, and bone masks. The body is
 * shared, the character is not.
 */
import { z } from 'zod';

/** The bundled canonical body lives here (built by tools/roster/). */
export const CANONICAL_BODY_DIR = 'bodies';
export const CANONICAL_BODY_FILE = 'body.glb';
export const CANONICAL_BODY_MANIFEST = 'body.json';

/**
 * A named region of the canonical body, in UV space and by joint. Regions are
 * what let a decal say "left forearm" instead of "these 400 texels", and what
 * bone masks address when a character keeps its own head but the roster's
 * shared torso.
 */
export const BodyRegionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** joints whose influence defines this region */
  joints: z.array(z.string().min(1)).min(1),
  /** the UV island bounds, so a decal can be placed without reading geometry */
  uvRect: z.strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  }),
  /** which side of the body, for the mirroring rules (D-008) */
  side: z.enum(['left', 'right', 'center']),
});
export type BodyRegion = z.output<typeof BodyRegionSchema>;

export const CanonicalBodySchema = z.strictObject({
  schemaVersion: z.int().positive(),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string().min(1),
  /** SPDX-ish id of the SOURCE mesh — bundled, so it must be permissive */
  license: z.string().min(1),
  source: z.string().min(1),
  /** the skeleton convention; Track A is humanoid by definition */
  skeleton: z.literal('ual-humanoid'),
  jointCount: z.int().positive(),
  vertexCount: z.int().positive(),
  /** standing height of the body as authored, metres (D-012 convention) */
  heightM: z.number().positive(),
  regions: z.array(BodyRegionSchema),
});
export type CanonicalBody = z.output<typeof CanonicalBodySchema>;

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

/**
 * Fitting the canonical body to a target mesh, with the numbers that say
 * whether it worked. `meanSurfaceErrorM` is the honest headline: the canonical
 * body will never match a generated silhouette exactly, and a fit that claims
 * otherwise is lying. What matters is that the error is bounded and that no
 * joint ended up outside the body it is supposed to drive.
 */
export const FitResultSchema = z.strictObject({
  schemaVersion: z.int().positive(),
  bodyId: z.string().min(1),
  /** per-axis scale applied to the canonical body */
  scale: z.tuple([z.number(), z.number(), z.number()]),
  /** target height the body was fitted to, metres */
  heightM: z.number().positive(),
  /** mean/max distance from a fitted body vertex to the target surface */
  meanSurfaceErrorM: z.number().nonnegative(),
  maxSurfaceErrorM: z.number().nonnegative(),
  /** vertices whose transferred weights had to be renormalized */
  renormalizedVertices: z.int().nonnegative(),
  /** joints that ended up outside the target mesh's bounds — a real failure */
  strayJoints: z.array(z.string()),
});
export type FitResult = z.output<typeof FitResultSchema>;

// ---------------------------------------------------------------------------
// Mirroring (D-008)
// ---------------------------------------------------------------------------

/**
 * Which baked directions may be produced by mirroring another, and which must
 * be rendered.
 *
 * A character viewed from yaw θ and from yaw −θ are mirror images ONLY if the
 * character itself is bilaterally symmetric. So for N directions the map is
 * `d -> (N - d) % N`: direction 0 (front) and N/2 (back) are self-symmetric and
 * always rendered; the rest pair up, and we render the first half and mirror
 * the second. For N=8 that renders 5 and mirrors 3 — a 37.5% saving on the
 * render, style, and cache work.
 *
 * It is OPT-IN per character (D-008) because the saving is a LIE for anyone
 * asymmetric: a tattoo on the left arm appears on the right arm in the
 * mirrored directions, a prosthetic swaps sides, and text reads backwards.
 * SpriteBook's founding constraint is that asymmetric identity is first-class,
 * so the default is off and nothing infers it from geometry.
 */
export function mirrorSource(direction: number, directions: number): number | null {
  if (direction <= 0 || direction * 2 === directions) return null; // self-symmetric
  const source = (directions - direction) % directions;
  return source < direction ? source : null;
}

/** The directions that must actually be rendered when mirroring is on. */
export function renderedDirections(directions: number, mirroring: boolean): number[] {
  const all = Array.from({ length: directions }, (_, i) => i);
  if (!mirroring) return all;
  return all.filter((d) => mirrorSource(d, directions) === null);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * A decal composited into the character's texture at bake time. `region`
 * names a BodyRegion so the placement survives a re-fit; `uvRect` overrides it
 * for a user who placed the decal by hand.
 *
 * `mirrored` is per-decal and defaults false, for the same reason the
 * character-level flag does: a tattoo the user put on one arm belongs on one
 * arm.
 */
export const DecalPlacementSchema = z.strictObject({
  id: z.string().min(1),
  pngPath: z.string().min(1),
  region: z.string().optional(),
  uvRect: z.strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  }).optional(),
  /** draw order; higher wins where two decals overlap */
  z: z.int().default(0),
  mirrored: z.boolean().default(false),
});
export type DecalPlacement = z.output<typeof DecalPlacementSchema>;

/** A mesh attached at one of the body's sockets (prop, prosthetic, hair). */
export const AttachmentPlacementSchema = z.strictObject({
  id: z.string().min(1),
  socketId: z.string().min(1),
  meshPath: z.string().min(1),
  /** local offset/rotation from the socket, if the user nudged it */
  offset: z.tuple([z.number(), z.number(), z.number()]).optional(),
});
export type AttachmentPlacement = z.output<typeof AttachmentPlacementSchema>;

/**
 * Which regions of the shared body this character replaces with its own
 * geometry — the escape hatch that keeps a roster from looking like one body
 * in different hats. Maps region id -> the mesh that replaces it.
 */
export const BoneMaskSchema = z.record(z.string(), z.string());
export type BoneMask = z.output<typeof BoneMaskSchema>;
