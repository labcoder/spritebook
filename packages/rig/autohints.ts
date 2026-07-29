/**
 * Auto-hints: turn a deform report into `--rerun-with-hints` edits (P3-T3).
 *
 * The deform check names torn joints but not where they should be. The one
 * target this can compute without taste is the centroid of the flesh a joint
 * DRIVES — its influenced vertices above the weight floor. A joint far from
 * that centroid is mis-placed relative to its own weights, and relocating it
 * before the skin re-solve is exactly the repair `--rerun-with-hints` can make.
 *
 * Measured (spikes/trellis2/HINTS-REPORT.md, three subjects):
 *
 *   bulma clavicle_r   169 mm off -> torn band 1.70% -> 0.27% (6x, repaired)
 *   bulma spine_02      21 mm off -> 1.46% -> 1.33%           (still torn)
 *   mermaid, 44 joints 330-660 mm -> overall 12.7% -> 4.9%    (2.6x)
 *   astro, floating parts, similar offsets -> 18.5% -> 15.0%  (the limit:
 *     no placement fixes weights across detached components)
 *
 * So the offset IS the signal: joints sitting on their centroid have no
 * placement error to exploit, and hinting them re-rolls the dice while looking
 * like a repair. `deriveAutoHints` therefore splits flagged joints at
 * `minOffsetM` and reports both halves — the caller warns about the below-floor
 * half in exactly those terms, so the residual reads as a backend limit rather
 * than something more clicking will fix.
 */
import type { DeformReport, JointEdit, RigSkeleton } from '@spritebook/schema';
import { DEFAULT_WEIGHT_FLOOR } from './deform.ts';
import { loadRiggedAsset, restWorlds, skinAll, skinMatrices } from './skin.ts';

/**
 * Below this offset, moving the joint measurably does not repair the tear:
 * 21 mm did nothing, 42 mm was borderline, 169 mm+ repaired decisively. 50 mm
 * splits the measured populations; it is argued from those three points, not
 * derived, and it says so here rather than pretending precision.
 */
export const DEFAULT_MIN_HINT_OFFSET_M = 0.05;

export interface AutoHints {
  /** flagged joints far enough from their flesh to be worth relocating */
  edits: JointEdit[];
  /** flagged joints already sitting on their flesh — nothing to exploit */
  belowFloor: Array<{ joint: string; offsetM: number }>;
  /** flagged joints whose influence set spans DETACHED shells. Reported apart
   * from `belowFloor` because the cause differs and so does the remedy: no
   * placement repairs a joint asked to drive geometry it does not touch, and
   * the fix is to join the pieces, not to nudge anything. */
  crossComponent: Array<{ joint: string; components: number }>;
  /** flagged joints that could not be measured (no vertices above the floor,
   * or missing from the skeleton) — surfaced, never silently dropped */
  unmeasurable: string[];
}

export interface AutoHintOptions {
  weightFloor?: number;
  minOffsetM?: number;
}

/** Centroid-offset edits for every `excessive-stretch` joint in the report. */
export async function deriveAutoHints(
  riggedPath: string,
  report: DeformReport,
  skeleton: RigSkeleton,
  opts: AutoHintOptions = {},
): Promise<AutoHints> {
  const weightFloor = opts.weightFloor ?? DEFAULT_WEIGHT_FLOOR;
  const minOffsetM = opts.minOffsetM ?? DEFAULT_MIN_HINT_OFFSET_M;

  const torn = report.joints
    .filter((j) => j.flags.includes('excessive-stretch'))
    .map((j) => j.joint);
  const head = new Map(skeleton.joints.map((j) => [j.name, j.head]));

  const asset = await loadRiggedAsset(riggedPath);
  // the SKINNED rest, exactly as the deform check measures — for a healthy
  // bind this equals the raw positions, and when it does not, the skinned
  // frame is the one the joint heads live in
  const rest = skinAll(asset, skinMatrices(restWorlds(asset), asset.inverseBind, asset.jointCount));
  const jointIndex = new Map(asset.jointNames.map((n, i) => [n, i]));

  const out: AutoHints = { edits: [], belowFloor: [], crossComponent: [], unmeasurable: [] };
  const spannedBy = new Map(report.joints.map((j) => [j.joint, j.spannedComponents]));
  for (const name of torn) {
    // A joint straddling shells is diagnosed FIRST: its centroid sits in the
    // gap between the pieces, so the derivation would happily produce a large
    // offset that repairs nothing. Naming the real cause beats hinting into
    // the void.
    const spans = spannedBy.get(name) ?? 1;
    if (spans > 1) {
      out.crossComponent.push({ joint: name, components: spans });
      continue;
    }
    const si = jointIndex.get(name);
    const h = head.get(name);
    if (si === undefined || h === undefined) {
      out.unmeasurable.push(name);
      continue;
    }
    let n = 0;
    const c = [0, 0, 0];
    for (let v = 0; v < asset.vertexCount; v++) {
      for (let k = 0; k < 4; k++) {
        if (asset.joints[v * 4 + k] === si && asset.weights[v * 4 + k] > weightFloor) {
          c[0] += rest[v * 3];
          c[1] += rest[v * 3 + 1];
          c[2] += rest[v * 3 + 2];
          n++;
          break;
        }
      }
    }
    if (n === 0) {
      out.unmeasurable.push(name);
      continue;
    }
    const delta: [number, number, number] = [
      c[0] / n - h[0],
      c[1] / n - h[1],
      c[2] / n - h[2],
    ];
    const offsetM = Math.hypot(...delta);
    if (offsetM < minOffsetM) out.belowFloor.push({ joint: name, offsetM });
    else out.edits.push({ joint: name, delta, mirrored: false });
  }
  return out;
}
