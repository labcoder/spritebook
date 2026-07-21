/**
 * The deform check (P3-T3): does this rig actually deform, and does it shred?
 *
 * The contact sheets are the human half of that question; this is the numeric
 * half. schema/rig.ts fixes the method: poses are generated PROCEDURALLY from
 * the rig itself — each joint bent in turn — because a Track B skeleton is
 * generic (22-52 joints, often named `bone_7`, sometimes not even humanoid) and
 * a humanoid clip cannot be replayed onto it without a mapping that does not
 * exist. Bending each joint works on any skeleton and measures exactly what the
 * check is for.
 *
 * ## The pose, per joint
 *
 * Two poses per joint: the joint alone rotated by +angle and -angle about ONE
 * axis, everything else at rest. The axis is the world basis axis MOST
 * PERPENDICULAR to the bone (smallest |dot| with the bone direction; ties
 * broken X then Y then Z), Gram-Schmidt-orthogonalized against the bone so it
 * is exactly perpendicular. Perpendicular is the point: rotating a bone about
 * its OWN axis is a twist, which moves a symmetric limb's vertices barely at
 * all, and a check whose pose cannot move anything cannot tell a dead joint
 * from a live one. Picking from the world basis (rather than, say, the bone's
 * own local X) keeps the swing plane meaningful for a rig whose roll
 * convention we did not choose. The bone direction is the joint's local +Y in
 * world space — the frame `applyRig` writes.
 *
 * The rotation happens about the joint's own head, so the joint's subtree
 * follows and nothing else moves: `world' = T(head) . R . T(-head) . world` for
 * the joint and every descendant, rest elsewhere. No FK pass is needed —
 * parents precede children, so the delta propagates by construction.
 *
 * ## What is measured, over which vertices
 *
 * Only the vertices a joint influences above `weightFloor` — the ones it is
 * responsible for. Displacement is measured against the SKINNED rest pose (not
 * the raw authored positions) so the numbers are the effect of the pose alone,
 * not of any bind-matrix error the round-trip test already covers.
 *
 * `maxEdgeStretch` is the shredding signature (P0-T4 catalog item 1: "the
 * Giant's arm/torso boundary weights are rough — visible shredding under
 * animation"). Shredding is not vertices moving far, it is neighbours moving
 * DIFFERENTLY: an edge whose endpoints are weighted to joints that swing apart
 * stretches without bound while its neighbours sit still. So the metric is the
 * largest length ratio over mesh edges with BOTH endpoints inside the
 * influenced set, and 2.0 (an edge doubling in length at a 30-degree bend) is
 * the default line between "soft falloff" and "torn".
 *
 * ## Cost
 *
 * O(V + J.E): the rest skin is computed once over all vertices, per-joint work
 * touches only that joint's influenced set, and the edge pass is one linear
 * scan per joint against a membership flag. Nothing is capped and nothing is
 * sampled — every joint and every influenced vertex is measured.
 */
import type { DeformJointStat, DeformReport } from '@spritebook/schema';
import { DeformReportSchema, parseWith, SCHEMA_VERSION } from '@spritebook/schema';
import { qAxisAngle, qToMat4, vDot, type Vec3, vLen, vNormalize } from '../anim/quat.ts';
import {
  loadRiggedAsset,
  mat4Multiply,
  restWorlds,
  type RiggedAsset,
  skinAll,
  skinMatrices,
  skinVertex,
} from './skin.ts';

/** The deform check writes exactly this file into `outDir`. */
export const DEFORM_REPORT_FILE = 'deform-report.json';
/** Bend angle per joint, degrees — big enough to move, small enough to be sane. */
export const DEFAULT_ANGLE_DEG = 30;
/** A joint "influences" a vertex when its weight exceeds this. */
export const DEFAULT_WEIGHT_FLOOR = 0.05;
/** Edge length ratio above which the deformation is torn, not soft. */
export const DEFAULT_STRETCH_THRESHOLD = 2;
/** Max displacement at or below this (0.1 mm) means the joint did nothing. */
export const DEAD_JOINT_EPS_M = 1e-4;
/** Rest edges shorter than this cannot yield a ratio; they are skipped. */
const DEGENERATE_EDGE_M = 1e-9;

export interface DeformCheckOptions {
  /** the rigged glb (applyRig's output) */
  riggedPath: string;
  /** the report lands at `<outDir>/deform-report.json` */
  outDir: string;
  angleDeg?: number;
  weightFloor?: number;
  /** `maxEdgeStretch` above this flags `excessive-stretch` (default 2) */
  stretchThreshold?: number;
  /** injectable clock — the report's `at` is the only non-deterministic field */
  now?: () => string;
}

/** Unique undirected edges of the triangle list, as [a, b] pairs with a < b. */
export function uniqueEdges(indices: Uint32Array, vertexCount: number): Uint32Array {
  const seen = new Set<number>();
  const out: number[] = [];
  const add = (a: number, b: number) => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    if (lo === hi) return;
    const key = lo * vertexCount + hi;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(lo, hi);
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    add(indices[t], indices[t + 1]);
    add(indices[t + 1], indices[t + 2]);
    add(indices[t + 2], indices[t]);
  }
  return Uint32Array.from(out);
}

/** Vertices each joint influences above the floor — one pass over the weights. */
function influenceBuckets(asset: RiggedAsset, floor: number): number[][] {
  const buckets: number[][] = Array.from({ length: asset.jointCount }, () => []);
  for (let v = 0; v < asset.vertexCount; v++) {
    for (let k = 0; k < 4; k++) {
      if (asset.weights[v * 4 + k] > floor) buckets[asset.joints[v * 4 + k]].push(v);
    }
  }
  // a vertex can list the same joint twice (adapters do); keep it once
  return buckets.map((b) => [...new Set(b)]);
}

/** The joint's bone direction: its local +Y in world space (applyRig's frame). */
export function boneDirection(world: ArrayLike<number>): Vec3 {
  const y: Vec3 = [world[4], world[5], world[6]];
  return vLen(y) < 1e-12 ? [0, 1, 0] : vNormalize(y);
}

/**
 * The world basis axis most perpendicular to `d`, orthogonalized against it.
 * Ties break X < Y < Z, so the answer is a deterministic function of the rig.
 */
export function dominantPerpendicularAxis(d: Vec3): Vec3 {
  let best = 0;
  for (let a = 1; a < 3; a++) if (Math.abs(d[a]) < Math.abs(d[best])) best = a;
  const e: Vec3 = [0, 0, 0];
  e[best] = 1;
  const p = vDot(d, e);
  return vNormalize([e[0] - d[0] * p, e[1] - d[1] * p, e[2] - d[2] * p]);
}

/** `T(pivot) . R(axis, rad) . T(-pivot)`, column-major. */
function rotationAbout(axis: Vec3, rad: number, pivot: Vec3): Float32Array {
  const m = qToMat4(qAxisAngle(axis, rad));
  m[12] = pivot[0] - (m[0] * pivot[0] + m[4] * pivot[1] + m[8] * pivot[2]);
  m[13] = pivot[1] - (m[1] * pivot[0] + m[5] * pivot[1] + m[9] * pivot[2]);
  m[14] = pivot[2] - (m[2] * pivot[0] + m[6] * pivot[1] + m[10] * pivot[2]);
  return m;
}

/** Joints in `joint`'s subtree, including itself (parents precede children). */
function subtreeMask(parents: Int32Array, joint: number): Uint8Array {
  const mask = new Uint8Array(parents.length);
  mask[joint] = 1;
  for (let i = joint + 1; i < parents.length; i++) {
    const p = parents[i];
    if (p >= 0 && mask[p]) mask[i] = 1;
  }
  return mask;
}

/**
 * Bend every joint in turn and report what moved. Writes
 * `<outDir>/deform-report.json` and returns the same report.
 */
export async function deformCheck(opts: DeformCheckOptions): Promise<DeformReport> {
  const angleDeg = opts.angleDeg ?? DEFAULT_ANGLE_DEG;
  const weightFloor = opts.weightFloor ?? DEFAULT_WEIGHT_FLOOR;
  const stretchThreshold = opts.stretchThreshold ?? DEFAULT_STRETCH_THRESHOLD;
  const now = opts.now ?? (() => new Date().toISOString());
  if (!(angleDeg > 0)) throw new Error(`deformCheck: angleDeg must be positive, got ${angleDeg}`);
  if (!(weightFloor >= 0 && weightFloor < 1)) {
    throw new Error(`deformCheck: weightFloor must be in [0, 1), got ${weightFloor}`);
  }

  const asset = await loadRiggedAsset(opts.riggedPath);
  const rest = restWorlds(asset);
  const restMats = skinMatrices(rest, asset.inverseBind, asset.jointCount);
  const restPos = skinAll(asset, restMats);

  const edges = uniqueEdges(asset.indices, asset.vertexCount);
  const buckets = influenceBuckets(asset, weightFloor);
  const rad = (angleDeg * Math.PI) / 180;
  const signs = [1, -1];
  const poses = signs.map((s) => `bend${s > 0 ? '+' : '-'}${angleDeg}deg`);

  const influenced = new Uint8Array(asset.vertexCount);
  const posed = signs.map(() => new Float32Array(asset.vertexCount * 3));
  const worlds = new Float32Array(asset.jointCount * 16);
  const mats = new Float32Array(asset.jointCount * 16);
  const scratch: [number, number, number] = [0, 0, 0];

  const stats: DeformJointStat[] = [];
  for (let j = 0; j < asset.jointCount; j++) {
    const joint = asset.jointNames[j] || `joint_${j}`;
    const verts = buckets[j];
    if (verts.length === 0) {
      stats.push({
        joint,
        influencedVertices: 0,
        meanDisplacementM: 0,
        maxDisplacementM: 0,
        maxEdgeStretch: 0,
        flags: ['no-influence'],
      });
      continue;
    }

    const world = rest.subarray(j * 16, j * 16 + 16);
    const pivot: Vec3 = [world[12], world[13], world[14]];
    const axis = dominantPerpendicularAxis(boneDirection(world));
    const mask = subtreeMask(asset.jointParents, j);
    for (const v of verts) influenced[v] = 1;

    for (let p = 0; p < signs.length; p++) {
      const delta = rotationAbout(axis, signs[p] * rad, pivot);
      for (let i = 0; i < asset.jointCount; i++) {
        const w = worlds.subarray(i * 16, i * 16 + 16);
        if (mask[i]) mat4Multiply(delta, rest.subarray(i * 16, i * 16 + 16), w);
        else w.set(rest.subarray(i * 16, i * 16 + 16));
      }
      skinMatrices(worlds, asset.inverseBind, asset.jointCount, mats);
      const out = posed[p];
      for (const v of verts) {
        skinVertex(asset, mats, v, scratch);
        out[v * 3] = scratch[0], out[v * 3 + 1] = scratch[1], out[v * 3 + 2] = scratch[2];
      }
    }

    let sum = 0;
    let maxDisplacementM = 0;
    for (const v of verts) {
      let d = 0;
      for (const out of posed) {
        d = Math.max(
          d,
          Math.hypot(
            out[v * 3] - restPos[v * 3],
            out[v * 3 + 1] - restPos[v * 3 + 1],
            out[v * 3 + 2] - restPos[v * 3 + 2],
          ),
        );
      }
      sum += d;
      if (d > maxDisplacementM) maxDisplacementM = d;
    }
    const meanDisplacementM = sum / verts.length;

    let maxEdgeStretch = 0;
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e], b = edges[e + 1];
      if (!influenced[a] || !influenced[b]) continue;
      const restLen = Math.hypot(
        restPos[a * 3] - restPos[b * 3],
        restPos[a * 3 + 1] - restPos[b * 3 + 1],
        restPos[a * 3 + 2] - restPos[b * 3 + 2],
      );
      if (restLen < DEGENERATE_EDGE_M) continue;
      for (const out of posed) {
        const len = Math.hypot(
          out[a * 3] - out[b * 3],
          out[a * 3 + 1] - out[b * 3 + 1],
          out[a * 3 + 2] - out[b * 3 + 2],
        );
        const ratio = len / restLen;
        if (ratio > maxEdgeStretch) maxEdgeStretch = ratio;
      }
    }

    const flags: DeformJointStat['flags'] = [];
    if (maxDisplacementM <= DEAD_JOINT_EPS_M) flags.push('dead-joint');
    if (maxEdgeStretch > stretchThreshold) flags.push('excessive-stretch');
    stats.push({
      joint,
      influencedVertices: verts.length,
      meanDisplacementM,
      maxDisplacementM,
      maxEdgeStretch,
      flags,
    });

    for (const v of verts) influenced[v] = 0;
  }

  const report: DeformReport = {
    schemaVersion: SCHEMA_VERSION,
    at: now(),
    poses,
    joints: stats,
    flaggedJoints: stats.filter((s) => s.flags.length > 0).map((s) => s.joint),
  };
  parseWith(DeformReportSchema, report, 'DeformReport');

  await Deno.mkdir(opts.outDir, { recursive: true });
  await Deno.writeTextFile(
    `${opts.outDir}/${DEFORM_REPORT_FILE}`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}
