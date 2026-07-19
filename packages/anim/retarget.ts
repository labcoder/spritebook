/**
 * Humanoid retarget core (P3-T1). Pure TS math — no GPU, no IO, no clock/RNG;
 * `retargetClip` is a pure function of its arguments (determinism law).
 *
 * THE TRANSFER FORMULA (animation-retargeting skill: transfer world-space bone
 * ORIENTATIONS only, through measured rest-pose deltas, conjugated by the
 * MEASURED facing yaw — never absolute placements, never rest-head rotation):
 *
 *   Per mapped joint j at time t, unit quats, ⊗ = qMul (right operand first):
 *     srcWorld_j(t) = srcWorldParent_j(t) ⊗ srcLocal_j(t)      (FK down the chain)
 *     delta_j(t)    = srcWorld_j(t) ⊗ conj(srcRestWorld_j)     (world-frame delta from rest)
 *     tgtWorld_j(t) = Y ⊗ delta_j(t) ⊗ conj(Y) ⊗ tgtRestWorld_j
 *     tgtLocal_j(t) = conj(tgtWorldParent_j(t)) ⊗ tgtWorld_j(t)
 *
 *   Unrolled: tgtWorld = Y ⊗ srcWorld ⊗ conj(srcRestWorld) ⊗ conj(Y) ⊗ tgtRestWorld.
 *   Y is the facing-yaw conjugation quat: a rotation about world +Y by
 *   (targetRestYaw − sourceRestYaw), each yaw MEASURED from the rest skeleton
 *   (explicit side-pair anchors -> left axis -> forward = left × up; see
 *   `measureRestFacingYaw`). `delta` is a rotation expressed in the SOURCE's
 *   world frame, so moving it into a rig whose rest faces elsewhere is the
 *   conjugation Y ⊗ delta ⊗ conj(Y) — a plain premultiply by Y (without the
 *   conj(Y)) is only equal when Y ≈ identity. For the bundled fixtures the
 *   measured yaw is ~0 (< 1e-3 rad), where both forms coincide; the
 *   conjugation is what stays correct for a yawed rig.
 *
 *   Why the world-frame (left) delta and not a rest-local (right) delta: with
 *   `delta = srcWorld ⊗ conj(srcRestWorld)` the world DIRECTION of every bone
 *   transfers exactly — tgtDir(t) = delta(t) · tgtRestDir, and when source and
 *   target rest poses agree semantically (standing, legs down, same facing)
 *   tgtRestDir ≈ srcRestDir, so knees hinge about the same world axis with the
 *   same flexion. A rest-local delta re-expresses the motion in each rig's
 *   arbitrary bone frame (UAL bones are Y-along-bone, the fixture rigs are
 *   identity-oriented) and reproduces exactly the P0-T4 "ostrich knees".
 *
 * TRANSLATION: only the hips track transfers —
 *     tgtHipsWorldPos(t) = tgtHipsRestWorldPos
 *                        + hipScale · (Y · (srcHipsWorldPos(t) − srcHipsRestWorldPos))
 *                        + [0, footCorrection(t), 0]
 *   with hipScale = tgtHipsRestWorldY / srcHipsRestWorldY (the leg-length /
 *   hip-height ratio; identical for rigs whose feet rest on the ground plane),
 *   converted back to a parent-local translation against the transferred
 *   parent chain. Every other translation track and every scale track is
 *   DROPPED — bone lengths and proportions belong to the TARGET skeleton.
 *
 * FOOT-GROUND CORRECTION (skill: a correction pass, not an outcome of good
 * transfer): contact frames are grid frames where a source foot's world Y is
 * within CONTACT_EPS_M of that foot's own rest world Y. Per contact frame the
 * pelvis gets the world-Y offset that puts the LOWEST contact foot exactly at
 * its target rest height; offsets on non-contact frames are linearly
 * interpolated in time between contact neighbours (held at the ends); the
 * whole offset curve is smoothed once with a [1, 2, 1]/4 kernel so the
 * correction never steps frame-to-frame. stats.footContactMaxErrM is the max
 * residual |tgtFootY − tgtFootRestY| of the lowest contact foot AFTER the
 * smoothed correction — measured, not assumed (numbers first, eyeballs
 * second).
 *
 * OUTPUT: tracks on the union of the mapped source tracks' key times (every
 * output track shares one grid — parent-chain transfer is evaluated per frame,
 * so per-joint private timelines would interpolate through unevaluated
 * parents). All output tracks are LINEAR; rotations are unit quats made
 * hemisphere-continuous (no adjacent-frame dot < 0). Mapped joints get a
 * rotation track (hips also a translation track); unmapped target joints stay
 * at rest and are REPORTED, never guessed; source tracks with no target joint
 * are dropped and reported. Report arrays are sorted alphabetically
 * (deterministic); the clip's track order is target hierarchy order. The
 * output clip keeps the source clip id — naming belongs to the caller.
 */
import type {
  Clip,
  HumanoidProfile,
  JointTrack,
  MappingReport,
  RetargetResult,
  SkeletonRest,
} from './contracts.ts';
import {
  qAxisAngle,
  qConj,
  qFromMat4,
  qIdentity,
  qMul,
  qNormalize,
  qRotate,
  qSlerp,
  type Quat,
  vAdd,
  type Vec3,
  vLen,
  vNormalize,
  vScale,
  vSub,
} from './quat.ts';

/**
 * A source foot counts as grounded when its world Y is within this many meters
 * of its own rest world Y (measured on ual-subset Walk_Loop: planted-ankle
 * excursion stays well inside this; swing lifts far above it).
 */
export const CONTACT_EPS_M = 0.02;

// ---------------------------------------------------------------------------
// Rest-skeleton FK
// ---------------------------------------------------------------------------

interface RestJoint {
  parent: string;
  rot: Quat;
  pos: Vec3;
}

interface RestSkeleton {
  /** topological order, parents before children */
  order: string[];
  local: Map<string, RestJoint>;
  worldRot: Map<string, Quat>;
  worldPos: Map<string, Vec3>;
}

function buildRestSkeleton(rest: SkeletonRest, label: string): RestSkeleton {
  const names = [...rest.locals.keys()];
  const local = new Map<string, RestJoint>();
  for (const name of names) {
    const m = rest.locals.get(name)!;
    const parent = rest.parents.get(name) ?? '';
    if (parent && !rest.locals.has(parent)) {
      throw new Error(
        `retarget: ${label} joint "${name}" references missing parent "${parent}"`,
      );
    }
    local.set(name, { parent, rot: qFromMat4(m), pos: [m[12], m[13], m[14]] });
  }
  const order: string[] = [];
  const placed = new Set<string>();
  let remaining = names;
  while (remaining.length > 0) {
    const ready = remaining.filter((n) => {
      const p = local.get(n)!.parent;
      return p === '' || placed.has(p);
    });
    if (ready.length === 0) {
      throw new Error(
        `retarget: ${label} skeleton has a parent cycle involving "${remaining[0]}"`,
      );
    }
    for (const n of ready) {
      order.push(n);
      placed.add(n);
    }
    remaining = remaining.filter((n) => !placed.has(n));
  }
  const worldRot = new Map<string, Quat>();
  const worldPos = new Map<string, Vec3>();
  for (const n of order) {
    const j = local.get(n)!;
    if (j.parent === '') {
      worldRot.set(n, j.rot);
      worldPos.set(n, j.pos);
    } else {
      const pr = worldRot.get(j.parent)!;
      const pp = worldPos.get(j.parent)!;
      worldRot.set(n, qNormalize(qMul(pr, j.rot)));
      worldPos.set(n, vAdd(pp, qRotate(pr, j.pos)));
    }
  }
  return { order, local, worldRot, worldPos };
}

// ---------------------------------------------------------------------------
// Track sampling (LINEAR / STEP; clamped outside the key range)
// ---------------------------------------------------------------------------

/** Rightmost key index i with times[i] <= t (clamped to 0). */
function keyBefore(times: Float32Array, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (t <= times[0]) return 0;
  if (t >= times[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

function sampleTrackQuat(track: JointTrack, t: number): Quat {
  const r = track.rotations!;
  const i = keyBefore(track.times, t);
  const a: Quat = [r[i * 4], r[i * 4 + 1], r[i * 4 + 2], r[i * 4 + 3]];
  if (track.interpolation === 'STEP' || i === track.times.length - 1 || t <= track.times[i]) {
    return a;
  }
  const dt = track.times[i + 1] - track.times[i];
  const u = dt > 0 ? (t - track.times[i]) / dt : 0;
  const b: Quat = [r[(i + 1) * 4], r[(i + 1) * 4 + 1], r[(i + 1) * 4 + 2], r[(i + 1) * 4 + 3]];
  return qSlerp(a, b, u);
}

function sampleTrackVec3(values: Float32Array, track: JointTrack, t: number): Vec3 {
  const i = keyBefore(track.times, t);
  const a: Vec3 = [values[i * 3], values[i * 3 + 1], values[i * 3 + 2]];
  if (track.interpolation === 'STEP' || i === track.times.length - 1 || t <= track.times[i]) {
    return a;
  }
  const dt = track.times[i + 1] - track.times[i];
  const u = dt > 0 ? (t - track.times[i]) / dt : 0;
  return [
    a[0] + (values[(i + 1) * 3] - a[0]) * u,
    a[1] + (values[(i + 1) * 3 + 1] - a[1]) * u,
    a[2] + (values[(i + 1) * 3 + 2] - a[2]) * u,
  ];
}

/**
 * Sample a clip's world pose on its own skeleton at time t. Rotation and
 * translation tracks are honoured (rest values fill the gaps); scale tracks
 * are ignored — proportions belong to the skeleton, and UAL ships unit scales.
 */
function samplePoseWorld(
  clip: Clip,
  sk: RestSkeleton,
  t: number,
): { rot: Map<string, Quat>; pos: Map<string, Vec3> } {
  const rot = new Map<string, Quat>();
  const pos = new Map<string, Vec3>();
  for (const n of sk.order) {
    const j = sk.local.get(n)!;
    const track = clip.tracks.get(n);
    const localRot = track?.rotations ? sampleTrackQuat(track, t) : j.rot;
    const localPos = track?.translations ? sampleTrackVec3(track.translations, track, t) : j.pos;
    if (j.parent === '') {
      rot.set(n, localRot);
      pos.set(n, localPos);
    } else {
      const pr = rot.get(j.parent)!;
      rot.set(n, qNormalize(qMul(pr, localRot)));
      pos.set(n, vAdd(pos.get(j.parent)!, qRotate(pr, localPos)));
    }
  }
  return { rot, pos };
}

// ---------------------------------------------------------------------------
// Facing yaw — measured, never assumed
// ---------------------------------------------------------------------------

function facingYawOf(sk: RestSkeleton, profile: HumanoidProfile): number {
  // Left axis from the profile's EXPLICIT side anchors: sum of normalized
  // (left − right) rest positions over every pair present in the skeleton.
  let left: Vec3 = [0, 0, 0];
  let pairs = 0;
  for (const [l, r] of profile.sidePairs) {
    const pl = sk.worldPos.get(l);
    const pr = sk.worldPos.get(r);
    if (!pl || !pr) continue;
    const d = vSub(pl, pr);
    if (vLen(d) < 1e-9) continue;
    left = vAdd(left, vNormalize(d));
    pairs++;
  }
  if (pairs === 0) return 0; // no side anchors -> yaw unmeasurable, treat as forward
  // project out the up component; forward = left × up
  const flat: Vec3 = [left[0], 0, left[2]];
  if (vLen(flat) < 1e-9) return 0; // left axis vertical? degenerate -> forward
  const l = vNormalize(flat);
  const forward: Vec3 = [-l[2], 0, l[0]]; // cross(left, [0,1,0])
  return Math.atan2(forward[0], forward[2]); // 0 = glTF forward +Z
}

/**
 * Measured facing yaw of a rest skeleton, radians about world +Y; 0 means the
 * glTF-conventional facing (+Z, left hand at +X). Exposed so tests can assert
 * the fixtures measure ~0 rather than assuming it.
 */
export function measureRestFacingYaw(rest: SkeletonRest, profile: HumanoidProfile): number {
  return facingYawOf(buildRestSkeleton(rest, 'skeleton'), profile);
}

// ---------------------------------------------------------------------------
// The retarget
// ---------------------------------------------------------------------------

export function retargetClip(
  source: Clip,
  sourceRest: SkeletonRest,
  targetRest: SkeletonRest,
  profile: HumanoidProfile,
): RetargetResult {
  const src = buildRestSkeleton(sourceRest, 'source');
  const tgt = buildRestSkeleton(targetRest, 'target');

  const hips = profile.hips;
  if (!src.local.has(hips)) {
    throw new Error(`retarget: source skeleton is missing the hips joint "${hips}"`);
  }
  if (!tgt.local.has(hips)) {
    throw new Error(`retarget: target skeleton is missing the hips joint "${hips}"`);
  }
  const srcHipY = src.worldPos.get(hips)![1];
  const tgtHipY = tgt.worldPos.get(hips)![1];
  if (!(srcHipY > 1e-6)) {
    throw new Error(
      `retarget: source hips rest height is ${srcHipY} m — cannot derive hipScale ` +
        '(is the source skeleton grounded with +Y up?)',
    );
  }
  const hipScale = tgtHipY / srcHipY;

  // facing yaw, measured per skeleton from the explicit side anchors
  const yaw = facingYawOf(tgt, profile) - facingYawOf(src, profile);
  const yawQ = qAxisAngle([0, 1, 0], yaw);
  const yawQInv = qConj(yawQ);

  // name-based mapping over the profile namespace — report, never guess
  const mapped = tgt.order.filter((n) => source.tracks.has(n));
  const mappedSet = new Set(mapped);
  const unmappedTarget = tgt.order.filter((n) => !source.tracks.has(n));
  const unmappedSource = [...source.tracks.keys()].filter((n) => !tgt.local.has(n));

  // one shared key-time grid: union of the mapped source tracks' key times
  const timeSet = new Set<number>();
  for (const n of mapped) for (const t of source.tracks.get(n)!.times) timeSet.add(t);
  const grid = [...timeSet].sort((a, b) => a - b);
  const nF = grid.length;

  // feet usable for ground correction: profile feet present on BOTH skeletons
  const feet = profile.feet.filter((f) => src.local.has(f) && tgt.local.has(f));
  const hipsMapped = mappedSet.has(hips);

  const rotOut = new Map<string, Float64Array>();
  for (const n of mapped) rotOut.set(n, new Float64Array(nF * 4));
  const hipGoal: Vec3[] = [];
  const hipParentRot: Quat[] = [];
  const hipParentPos: Vec3[] = [];
  const srcFootY = new Map<string, Float64Array>();
  const tgtFootY = new Map<string, Float64Array>();
  for (const f of feet) {
    srcFootY.set(f, new Float64Array(nF));
    tgtFootY.set(f, new Float64Array(nF));
  }

  for (let f = 0; f < nF; f++) {
    const t = grid[f];
    const pose = samplePoseWorld(source, src, t);
    const worldRot = new Map<string, Quat>();
    const worldPos = new Map<string, Vec3>();
    for (const n of tgt.order) {
      const j = tgt.local.get(n)!;
      const pRot = j.parent === '' ? qIdentity() : worldRot.get(j.parent)!;
      const pPos: Vec3 = j.parent === '' ? [0, 0, 0] : worldPos.get(j.parent)!;
      let localRot = j.rot;
      let localPos = j.pos;
      if (mappedSet.has(n)) {
        // tgtWorld = Y ⊗ (srcWorld ⊗ conj(srcRestWorld)) ⊗ conj(Y) ⊗ tgtRestWorld
        const delta = qMul(pose.rot.get(n)!, qConj(src.worldRot.get(n)!));
        const tgtWorld = qMul(yawQ, qMul(delta, qMul(yawQInv, tgt.worldRot.get(n)!)));
        localRot = qNormalize(qMul(qConj(pRot), tgtWorld));
        rotOut.get(n)!.set(localRot, f * 4);
        if (n === hips) {
          const deltaPos = vSub(pose.pos.get(hips)!, src.worldPos.get(hips)!);
          const goal = vAdd(tgt.worldPos.get(hips)!, vScale(qRotate(yawQ, deltaPos), hipScale));
          localPos = qRotate(qConj(pRot), vSub(goal, pPos));
          hipGoal.push(goal);
          hipParentRot.push(pRot);
          hipParentPos.push(pPos);
        }
      }
      worldRot.set(n, qNormalize(qMul(pRot, localRot)));
      worldPos.set(n, vAdd(pPos, qRotate(pRot, localPos)));
    }
    for (const foot of feet) {
      srcFootY.get(foot)![f] = pose.pos.get(foot)![1];
      tgtFootY.get(foot)![f] = worldPos.get(foot)![1];
    }
  }

  // ---- foot-ground correction pass ----------------------------------------
  const offsets = new Float64Array(nF);
  let footContactMaxErrM = 0;
  if (hipsMapped && feet.length > 0 && nF > 0) {
    const contact: boolean[] = new Array(nF).fill(false);
    const lowestRel = new Float64Array(nF); // tgtFootY − tgtFootRestY of the lowest contact foot
    for (let f = 0; f < nF; f++) {
      let bestRel = Infinity;
      for (const foot of feet) {
        const grounded = srcFootY.get(foot)![f] <= src.worldPos.get(foot)![1] + CONTACT_EPS_M;
        if (!grounded) continue;
        const rel = tgtFootY.get(foot)![f] - tgt.worldPos.get(foot)![1];
        if (rel < bestRel) bestRel = rel;
      }
      if (bestRel < Infinity) {
        contact[f] = true;
        lowestRel[f] = bestRel;
        offsets[f] = -bestRel; // put the lowest contact foot exactly at rest height
      }
    }
    const contactIdx = contact.flatMap((c, f) => (c ? [f] : []));
    if (contactIdx.length > 0) {
      // fill non-contact frames: linear in TIME between contact neighbours, held ends
      let k = 0;
      for (let f = 0; f < nF; f++) {
        if (contact[f]) continue;
        while (k < contactIdx.length && contactIdx[k] < f) k++;
        const next = k < contactIdx.length ? contactIdx[k] : -1;
        const prev = k > 0 ? contactIdx[k - 1] : -1;
        if (prev < 0) offsets[f] = offsets[next];
        else if (next < 0) offsets[f] = offsets[prev];
        else {
          const span = grid[next] - grid[prev];
          const u = span > 0 ? (grid[f] - grid[prev]) / span : 0;
          offsets[f] = offsets[prev] + (offsets[next] - offsets[prev]) * u;
        }
      }
      // smooth once: [1, 2, 1] / 4, clamped ends — no frame-to-frame steps
      const smoothed = new Float64Array(nF);
      for (let f = 0; f < nF; f++) {
        const a = offsets[Math.max(0, f - 1)];
        const b = offsets[f];
        const c = offsets[Math.min(nF - 1, f + 1)];
        smoothed[f] = (a + 2 * b + c) / 4;
      }
      offsets.set(smoothed);
      // residual AFTER correction: the numeric evidence (skill: numbers first)
      for (let f = 0; f < nF; f++) {
        if (!contact[f]) continue;
        footContactMaxErrM = Math.max(footContactMaxErrM, Math.abs(lowestRel[f] + offsets[f]));
      }
    } else {
      offsets.fill(0); // no source ground contact anywhere -> nothing to correct
    }
  }

  // hips local translation against the transferred parent chain, with the
  // world-Y correction folded into the world goal
  const hipLocal = new Float64Array(nF * 3);
  if (hipsMapped) {
    for (let f = 0; f < nF; f++) {
      const goal: Vec3 = [hipGoal[f][0], hipGoal[f][1] + offsets[f], hipGoal[f][2]];
      hipLocal.set(qRotate(qConj(hipParentRot[f]), vSub(goal, hipParentPos[f])), f * 3);
    }
  }

  // ---- assemble the target clip -------------------------------------------
  const tracks = new Map<string, JointTrack>();
  for (const n of mapped) {
    const rots = rotOut.get(n)!;
    // hemisphere continuity on the OUTPUT (quat products can land on either cover)
    for (let f = 1; f < nF; f++) {
      let d = 0;
      for (let c = 0; c < 4; c++) d += rots[f * 4 + c] * rots[(f - 1) * 4 + c];
      if (d < 0) { for (let c = 0; c < 4; c++) rots[f * 4 + c] = -rots[f * 4 + c]; }
    }
    const track: JointTrack = {
      times: Float32Array.from(grid),
      rotations: Float32Array.from(rots),
      interpolation: 'LINEAR',
    };
    if (n === hips) track.translations = Float32Array.from(hipLocal);
    tracks.set(n, track);
  }

  const report: MappingReport = {
    mapped: [...mapped].sort(),
    unmappedTarget: [...unmappedTarget].sort(),
    unmappedSource: [...unmappedSource].sort(),
  };

  return {
    clip: { id: source.id, duration: source.duration, tracks },
    report,
    stats: { footContactMaxErrM, hipScale },
  };
}
