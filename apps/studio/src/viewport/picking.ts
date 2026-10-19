/**
 * The viewport's pure arithmetic, react- and three-free so the Node suite can
 * hold it: screen-space joint picking (the viewport skill forbids raycasts on
 * skinned meshes — a raycast tests the BIND pose, so clicks miss the moment
 * the character moves), the mirror-partner rule, and the joint-edits file
 * core reads back.
 */

export interface ScreenJoint {
  name: string;
  /** device-independent pixels, origin top-left of the canvas */
  x: number;
  y: number;
  /** view-space depth; ties break toward the nearer joint */
  depth: number;
}

/**
 * The joint under the cursor: nearest within `radiusPx`, nearer depth wins a
 * tie. Null when nothing is close enough — a miss must deselect rather than
 * grab whatever happened to be on screen.
 */
export function pickJoint(
  joints: readonly ScreenJoint[],
  x: number,
  y: number,
  radiusPx: number,
): string | null {
  let best: ScreenJoint | null = null;
  let bestDist = Infinity;
  for (const j of joints) {
    const d = Math.hypot(j.x - x, j.y - y);
    if (d > radiusPx) continue;
    if (
      d < bestDist - 0.5 || (Math.abs(d - bestDist) <= 0.5 && best !== null && j.depth < best.depth)
    ) {
      best = j;
      bestDist = Math.min(d, bestDist);
    }
  }
  return best?.name ?? null;
}

/**
 * A joint's side partner, MIRRORING core's rule (packages/rig/edits.ts
 * sidePartner). Naming only, never geometry. picking_test.ts cross-checks
 * every pattern against core's own function so the two cannot drift — the
 * GUI only previews which joint will move; core does the actual mirroring
 * from the edit's `mirrored` flag.
 */
const SIDE_PATTERNS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^(.*)_l$/i, (m) => `${m[1]}_r`],
  [/^(.*)_r$/i, (m) => `${m[1]}_l`],
  [/^(.*)\.L$/, (m) => `${m[1]}.R`],
  [/^(.*)\.R$/, (m) => `${m[1]}.L`],
  [/^Left(.*)$/, (m) => `Right${m[1]}`],
  [/^Right(.*)$/, (m) => `Left${m[1]}`],
];

export function mirrorPartner(joint: string): string | null {
  for (const [re, swap] of SIDE_PATTERNS) {
    const m = joint.match(re);
    if (m) return swap(m);
  }
  return null;
}

export interface PendingEdit {
  joint: string;
  delta: [number, number, number];
  mirrored: boolean;
}

/** The `rig --edits <patch.json>` document, exactly as its schema wants it. */
export function editsFile(edits: readonly PendingEdit[]): { edits: PendingEdit[] } {
  return { edits: [...edits] };
}

/**
 * Fold repeated nudges of the same joint into one edit. A user drags a joint
 * three times; core should receive the SUM, not three edits it applies in
 * sequence to a skeleton that moved underneath them. `mirrored` is the latest
 * choice for that joint — it is a property of the intent, not of a drag.
 */
export function mergeEdits(
  existing: readonly PendingEdit[],
  next: PendingEdit,
): PendingEdit[] {
  const out = existing.map((e) => ({ ...e, delta: [...e.delta] as [number, number, number] }));
  const at = out.findIndex((e) => e.joint === next.joint);
  if (at < 0) return [...out, { ...next, delta: [...next.delta] as [number, number, number] }];
  const merged = out[at]!;
  merged.delta = [
    merged.delta[0] + next.delta[0],
    merged.delta[1] + next.delta[1],
    merged.delta[2] + next.delta[2],
  ];
  merged.mirrored = next.mirrored;
  // a nudge dragged back to nothing is not an edit
  return merged.delta.every((v) => Math.abs(v) < 1e-6) ? out.filter((_, i) => i !== at) : out;
}
