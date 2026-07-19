/**
 * UAL humanoid profile + glTF -> in-memory loaders for @spritebook/anim
 * (P3-T1). The profile is the semantic namespace for humanoid retargeting:
 * UE-style joint names as shipped by Quaternius UAL (65 joints, enumerated
 * from fixtures/ual-subset.glb). `core` is the 21-joint body that retargeting
 * requires — the three fixture humanoids implement exactly this set;
 * `extended` is everything else UAL carries (finger chains, toe balls and leaf
 * ends) — mapped when a target has them, reported (never guessed) when not.
 * Side pairs are EXPLICIT anchors (animation-retargeting skill: side
 * assignment from geometry alone ties itself to float noise), left first.
 *
 * Loaders produce the frozen contracts.ts shapes:
 * - `loadSkeletonRest`: every non-mesh node becomes a joint (name -> parent
 *   name + column-major local rest matrix). Mesh-bearing nodes are geometry
 *   carriers, not joints. Joint names must be present and unique — rests and
 *   tracks are keyed by name.
 * - `loadClip`: one named glTF animation -> Clip. glTF samplers are per-path
 *   (rotation / translation / scale each with their own key times) while a
 *   JointTrack carries ONE time array per joint, so paths are merged onto the
 *   union of that joint's key times, sampling each path with its declared
 *   interpolation (values at original keys are reproduced exactly; between
 *   keys the merge equals what a conforming player would evaluate anyway).
 *   Quaternion keys are normalized and made hemisphere-continuous (adjacent
 *   dot >= 0). LINEAR and STEP load; CUBICSPLINE throws actionably (contracts
 *   law: no silent fallback), as does a joint mixing LINEAR and STEP across
 *   its paths (a merged track has one mode, and relabeling STEP data as LINEAR
 *   would silently smear holds). Morph-target `weights` channels are not joint
 *   animation and are skipped.
 */
import { type Document, NodeIO } from '@gltf-transform/core';
import type { Clip, HumanoidProfile, JointTrack, LoadClip, SkeletonRest } from './contracts.ts';
import { qDot, qNormalize, qSlerp, type Quat } from './quat.ts';

const FINGERS = ['index', 'middle', 'pinky', 'ring', 'thumb'] as const;

/** UAL finger chain: <finger>_01.._03 + <finger>_04_leaf, one side. */
function fingerChain(finger: string, side: 'l' | 'r'): string[] {
  return [
    `${finger}_01_${side}`,
    `${finger}_02_${side}`,
    `${finger}_03_${side}`,
    `${finger}_04_leaf_${side}`,
  ];
}

const CORE: readonly string[] = [
  'root',
  'pelvis',
  'spine_01',
  'spine_02',
  'spine_03',
  'neck_01',
  'Head',
  'clavicle_l',
  'upperarm_l',
  'lowerarm_l',
  'hand_l',
  'clavicle_r',
  'upperarm_r',
  'lowerarm_r',
  'hand_r',
  'thigh_l',
  'calf_l',
  'foot_l',
  'thigh_r',
  'calf_r',
  'foot_r',
];

const EXTENDED: readonly string[] = [
  'ball_l',
  'ball_leaf_l',
  'ball_r',
  'ball_leaf_r',
  ...FINGERS.flatMap((f) => fingerChain(f, 'l')),
  ...FINGERS.flatMap((f) => fingerChain(f, 'r')),
];

/** Sided joint stems; every `<stem>_l` / `<stem>_r` pair in the skeleton. */
const SIDE_STEMS: readonly string[] = [
  'clavicle',
  'upperarm',
  'lowerarm',
  'hand',
  'thigh',
  'calf',
  'foot',
  'ball',
  'ball_leaf',
  ...FINGERS.flatMap((f) => [`${f}_01`, `${f}_02`, `${f}_03`, `${f}_04_leaf`]),
];

export const UAL_HUMANOID: HumanoidProfile = {
  id: 'ual-humanoid',
  core: CORE,
  extended: EXTENDED,
  sidePairs: SIDE_STEMS.map((s) => [`${s}_l`, `${s}_r`] as const),
  hips: 'pelvis',
  feet: ['foot_l', 'foot_r'],
};

// ---------------------------------------------------------------------------
// Skeleton rest pose
// ---------------------------------------------------------------------------

/**
 * Extract the rest skeleton from a glTF Document: every non-mesh node is a
 * joint (plain transform wrappers like UAL's `Armature` node included — they
 * carry rest transforms the world composition needs). Local rest matrices are
 * the nodes' composed TRS, column-major.
 */
export function loadSkeletonRest(doc: Document): SkeletonRest {
  const parents = new Map<string, string>();
  const locals = new Map<string, Float32Array>();
  for (const node of doc.getRoot().listNodes()) {
    if (node.getMesh()) continue; // geometry carrier, not a joint
    const name = node.getName();
    if (!name) {
      throw new Error(
        'loadSkeletonRest: unnamed joint node — every joint must be named (rests and tracks are keyed by name)',
      );
    }
    if (locals.has(name)) {
      throw new Error(
        `loadSkeletonRest: duplicate joint name "${name}" — joint names must be unique`,
      );
    }
    const parent = node.getParentNode();
    parents.set(name, parent && !parent.getMesh() ? parent.getName() : '');
    locals.set(name, new Float32Array(node.getMatrix()));
  }
  return { parents, locals };
}

// ---------------------------------------------------------------------------
// Clip loading
// ---------------------------------------------------------------------------

type PathName = 'translation' | 'rotation' | 'scale';

interface RawPath {
  times: number[];
  values: number[][];
  interpolation: 'LINEAR' | 'STEP';
}

/** Rightmost key index i with times[i] <= t (clamped to 0). */
function keyBefore(times: ArrayLike<number>, t: number): number {
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

function sampleVecPath(p: RawPath, t: number): number[] {
  const i = keyBefore(p.times, t);
  if (p.interpolation === 'STEP' || i === p.times.length - 1 || t <= p.times[i]) {
    return p.values[i].slice();
  }
  const dt = p.times[i + 1] - p.times[i];
  const u = dt > 0 ? (t - p.times[i]) / dt : 0;
  const a = p.values[i];
  const b = p.values[i + 1];
  return a.map((av, k) => av + (b[k] - av) * u);
}

function sampleQuatPath(p: RawPath, t: number): Quat {
  const i = keyBefore(p.times, t);
  const a = p.values[i] as [number, number, number, number];
  if (p.interpolation === 'STEP' || i === p.times.length - 1 || t <= p.times[i]) {
    return [a[0], a[1], a[2], a[3]];
  }
  const dt = p.times[i + 1] - p.times[i];
  const u = dt > 0 ? (t - p.times[i]) / dt : 0;
  const b = p.values[i + 1] as [number, number, number, number];
  return qSlerp([a[0], a[1], a[2], a[3]], [b[0], b[1], b[2], b[3]], u);
}

export const loadClip: LoadClip = (doc, animationName, clipId): Clip => {
  const animations = doc.getRoot().listAnimations();
  const anim = animations.find((a) => a.getName() === animationName);
  if (!anim) {
    const names = animations.map((a) => `"${a.getName()}"`).join(', ') || '(none)';
    throw new Error(
      `loadClip: animation "${animationName}" not found in document; available: ${names}`,
    );
  }

  const joints = new Map<string, Partial<Record<PathName, RawPath>>>();
  let duration = 0;

  for (const channel of anim.listChannels()) {
    const node = channel.getTargetNode();
    const path = channel.getTargetPath();
    const sampler = channel.getSampler();
    if (!node || !path || !sampler) continue; // dangling channel animates nothing
    if (path === 'weights') continue; // morph weights are not joint tracks
    const joint = node.getName();
    const where = `animation "${animationName}" channel ${joint || '<unnamed node>'}.${path}`;
    if (!joint) {
      throw new Error(`loadClip: ${where} targets an unnamed node — joints must be named`);
    }
    const interpolation = sampler.getInterpolation();
    if (interpolation === 'CUBICSPLINE') {
      throw new Error(
        `loadClip: ${where} uses CUBICSPLINE interpolation, which the anim contracts reject — ` +
          'resample the clip to LINEAR on export (e.g. gltf-transform resample()); no silent fallback',
      );
    }
    const input = sampler.getInput();
    const output = sampler.getOutput();
    if (!input || !output) {
      throw new Error(`loadClip: ${where} is missing its input or output accessor`);
    }
    const count = input.getCount();
    if (count === 0) throw new Error(`loadClip: ${where} has zero keyframes`);
    const width = path === 'rotation' ? 4 : 3;
    if (output.getElementSize() !== width) {
      throw new Error(
        `loadClip: ${where} output has ${output.getElementSize()} components, expected ${width}`,
      );
    }
    if (output.getCount() < count) {
      throw new Error(`loadClip: ${where} output has fewer elements than keyframe times`);
    }
    const el: number[] = [];
    const times: number[] = [];
    for (let i = 0; i < count; i++) {
      input.getElement(i, el);
      times.push(el[0]);
      if (i > 0 && !(times[i] > times[i - 1])) {
        throw new Error(`loadClip: ${where} keyframe times are not strictly ascending`);
      }
    }
    const values: number[][] = [];
    for (let i = 0; i < count; i++) values.push(output.getElement(i, []).slice(0, width));
    const per = joints.get(joint) ?? {};
    if (per[path as PathName]) throw new Error(`loadClip: ${where} is targeted by two channels`);
    per[path as PathName] = { times, values, interpolation };
    joints.set(joint, per);
    duration = Math.max(duration, times[count - 1]);
  }

  const tracks = new Map<string, JointTrack>();
  for (const [joint, per] of joints) {
    const present = (['rotation', 'translation', 'scale'] as const).filter((p) => per[p]);
    const modes = [...new Set(present.map((p) => per[p]!.interpolation))];
    if (modes.length > 1) {
      throw new Error(
        `loadClip: animation "${animationName}" joint "${joint}" mixes ${modes.join(' and ')} ` +
          'across its paths; a JointTrack has one interpolation mode — resample the clip on export',
      );
    }
    const interpolation = modes[0];

    const rot = per.rotation;
    if (rot) {
      // normalize + hemisphere-continuity on the keys BEFORE any sampling
      let prev: Quat | null = null;
      for (let i = 0; i < rot.values.length; i++) {
        const v = rot.values[i];
        let q = qNormalize([v[0], v[1], v[2], v[3]]);
        if (prev && qDot(prev, q) < 0) q = [-q[0], -q[1], -q[2], -q[3]];
        rot.values[i] = q;
        prev = q;
      }
    }

    const timeSet = new Set<number>();
    for (const p of present) for (const t of per[p]!.times) timeSet.add(t);
    const times = [...timeSet].sort((a, b) => a - b);
    const n = times.length;

    const track: JointTrack = { times: Float32Array.from(times), interpolation };
    if (rot) {
      const out = new Float32Array(n * 4);
      let prev: Quat | null = null;
      for (let i = 0; i < n; i++) {
        let q = sampleQuatPath(rot, times[i]);
        if (prev && qDot(prev, q) < 0) q = [-q[0], -q[1], -q[2], -q[3]];
        out.set(q, i * 4);
        prev = q;
      }
      track.rotations = out;
    }
    if (per.translation) {
      const out = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) out.set(sampleVecPath(per.translation, times[i]), i * 3);
      track.translations = out;
    }
    if (per.scale) {
      const out = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) out.set(sampleVecPath(per.scale, times[i]), i * 3);
      track.scales = out;
    }
    tracks.set(joint, track);
  }

  return { id: clipId, duration, tracks };
};

/** loadSkeletonRest over a glb on disk (bake-side convenience; same semantics). */
export async function loadSkeletonRestFromFile(path: string): Promise<SkeletonRest> {
  const doc = await new NodeIO().readBinary(await Deno.readFile(path));
  return loadSkeletonRest(doc);
}
