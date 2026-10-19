import { promises as fs } from 'node:fs';
/**
 * ClipBinding sampling + the poses artifact (P3-T1 integrator half). Samples a
 * Clip (native or retargeted) at the contract's frame times and writes the
 * poses file the render seam consumes by path. The SAME sampled matrices feed
 * the preview GLB — preview/bake parity by construction.
 *
 * Sampling semantics: the samples always span the WHOLE clip —
 *   loop:     t_i = (i / N) * duration          (exclusive end — no dup pose)
 *   holdLast: t_i = i * duration / (N - 1)      (lands on the end)
 * LINEAR (slerp/lerp) and STEP; clamped at track ends.
 *
 * `speed` is a PLAYBACK rate, not a sampling window. It used to divide the
 * duration here, which sampled only part of the cycle: `walk-loop:6@0.5`
 * covered 200% of a 1.2 s clip and clamped, shipping 6 frames of which the
 * last 3 were byte-identical frozen poses, while `@2` shipped half a stride
 * that snapped back every loop. Both reported `frames` distinct frames with no
 * warn. Speed now lives where a rate belongs: BakeManifest.clips[].fps is
 * `frames / (durationS / speed)`, so a consumer plays the whole animation in
 * `duration / speed` seconds — which is what asking for double speed means.
 */
import { canonicalJson } from '@spritebook/schema';
import type { Clip, JointTrack, PosesHeader, SkeletonRest } from './contracts.ts';
import { POSES_VERSION } from './contracts.ts';
import { qFromMat4, qNormalize, qSlerp, qToMat4, type Quat } from './quat.ts';

export interface SampleSpec {
  frames: number;
  speed: number;
  holdLast: boolean;
}

export interface SampledPoses {
  jointNames: string[];
  /** frames x joints x 16, column-major LOCAL matrices */
  data: Float32Array;
  frames: number;
}

/** The contract's frame times for a binding. Fails loud on a degenerate spec —
 * speed 0 would compose NaN into pose matrices and flow silently to the GPU. */
export function frameTimes(duration: number, spec: SampleSpec): number[] {
  if (!Number.isInteger(spec.frames) || spec.frames < 1) {
    throw new Error(`frameTimes: frames must be a positive integer, got ${spec.frames}`);
  }
  if (!Number.isFinite(spec.speed) || !(spec.speed > 0)) {
    throw new Error(`frameTimes: speed must be a positive finite number, got ${spec.speed}`);
  }
  // `speed` is validated above but deliberately NOT applied here — it is a
  // playback rate, carried by BakeManifest.clips[].fps. Sampling always spans
  // the whole clip so every frame is a distinct pose.
  const d = duration;
  const out: number[] = [];
  for (let i = 0; i < spec.frames; i++) {
    if (spec.holdLast) {
      out.push(spec.frames === 1 ? 0 : (i * d) / (spec.frames - 1));
    } else {
      out.push((i / spec.frames) * d);
    }
  }
  return out;
}

/** Binary search: greatest k with times[k] <= t (clamped into range). */
function keyIndex(times: Float32Array, t: number): number {
  let lo = 0, hi = times.length - 1;
  if (t <= times[0]) return 0;
  if (t >= times[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

function sampleVec(
  track: Float32Array,
  times: Float32Array,
  t: number,
  n: number,
  interpolation: JointTrack['interpolation'],
  out: Float32Array,
): void {
  const k = keyIndex(times, t);
  const k1 = Math.min(k + 1, times.length - 1);
  if (interpolation === 'STEP' || k === k1 || t <= times[k]) {
    out.set(track.subarray(k * n, k * n + n));
    return;
  }
  const span = times[k1] - times[k];
  const a = span > 0 ? Math.min((t - times[k]) / span, 1) : 0;
  for (let c = 0; c < n; c++) {
    out[c] = track[k * n + c] * (1 - a) + track[k1 * n + c] * a;
  }
}

function quatAt(track: Float32Array, k: number): Quat {
  return [track[k * 4], track[k * 4 + 1], track[k * 4 + 2], track[k * 4 + 3]];
}

function sampleQuat(
  track: Float32Array,
  times: Float32Array,
  t: number,
  interpolation: JointTrack['interpolation'],
): Quat {
  const k = keyIndex(times, t);
  const k1 = Math.min(k + 1, times.length - 1);
  if (interpolation === 'STEP' || k === k1 || t <= times[k]) {
    return qNormalize(quatAt(track, k));
  }
  const span = times[k1] - times[k];
  const a = span > 0 ? Math.min((t - times[k]) / span, 1) : 0;
  return qSlerp(quatAt(track, k), quatAt(track, k1), a);
}

/** rest local matrix -> [T xyz, R quat, S xyz] (qFromMat4 strips scale itself). */
function decomposeRest(m: Float32Array): { t: Float32Array; r: Quat; s: Float32Array } {
  return {
    t: Float32Array.of(m[12], m[13], m[14]),
    r: qFromMat4(m),
    s: Float32Array.of(
      Math.hypot(m[0], m[1], m[2]),
      Math.hypot(m[4], m[5], m[6]),
      Math.hypot(m[8], m[9], m[10]),
    ),
  };
}

/** Compose column-major local = T * R * S into out16. */
function composeTRS(t: ArrayLike<number>, r: Quat, s: ArrayLike<number>, out: Float32Array): void {
  qToMat4(r, out);
  for (let c = 0; c < 3; c++) {
    const sc = s[c];
    out[c * 4] *= sc;
    out[c * 4 + 1] *= sc;
    out[c * 4 + 2] *= sc;
  }
  out[12] = t[0];
  out[13] = t[1];
  out[14] = t[2];
  out[3] = 0;
  out[7] = 0;
  out[11] = 0;
  out[15] = 1;
}

/**
 * Sample a clip into per-frame joint local matrices. Joint set = every joint in
 * `rest` (canonical skeleton order); a joint without a track holds its rest.
 */
export function sampleClip(clip: Clip, rest: SkeletonRest, spec: SampleSpec): SampledPoses {
  const jointNames = [...rest.locals.keys()];
  const times = frameTimes(clip.duration, spec);
  const data = new Float32Array(times.length * jointNames.length * 16);

  const restParts = new Map(
    jointNames.map((n) => [n, decomposeRest(rest.locals.get(n)!)]),
  );
  const t3 = new Float32Array(3);
  const s3 = new Float32Array(3);

  times.forEach((t, fi) => {
    jointNames.forEach((name, ji) => {
      const parts = restParts.get(name)!;
      const track = clip.tracks.get(name);
      let tt: ArrayLike<number> = parts.t;
      let rr: Quat = parts.r;
      let ss: ArrayLike<number> = parts.s;
      if (track) {
        if (track.translations) {
          sampleVec(track.translations, track.times, t, 3, track.interpolation, t3);
          tt = t3;
        }
        if (track.rotations) {
          rr = sampleQuat(track.rotations, track.times, t, track.interpolation);
        }
        if (track.scales) {
          sampleVec(track.scales, track.times, t, 3, track.interpolation, s3);
          ss = s3;
        }
      }
      const o = (fi * jointNames.length + ji) * 16;
      composeTRS(tt, rr, ss, data.subarray(o, o + 16));
    });
  });

  return { jointNames, data, frames: times.length };
}

// ---------------------------------------------------------------------------
// Poses file IO (format per contracts.ts)
// ---------------------------------------------------------------------------
export async function writePoses(
  path: string,
  clipId: string,
  sampled: SampledPoses,
): Promise<void> {
  const header: PosesHeader = {
    clipId,
    frames: sampled.frames,
    jointNames: sampled.jointNames,
    version: POSES_VERSION,
  };
  const head = new TextEncoder().encode(canonicalJson(header)); // ends with \n
  const blob = new Uint8Array(sampled.data.buffer.slice(0), 0, sampled.data.byteLength);
  const out = new Uint8Array(head.length + blob.length);
  out.set(head, 0);
  out.set(blob, head.length);
  await fs.writeFile(path, out);
}

export async function readPoses(
  path: string,
): Promise<{ header: PosesHeader; data: Float32Array }> {
  const bytes = new Uint8Array(await fs.readFile(path));
  const nl = bytes.indexOf(0x0a);
  if (nl < 0) throw new Error(`${path}: not a poses file (no header line)`);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl))) as PosesHeader;
  if (header.version !== POSES_VERSION) {
    throw new Error(`${path}: poses version ${header.version}, expected ${POSES_VERSION}`);
  }
  if (
    typeof header.clipId !== 'string' || !Array.isArray(header.jointNames) ||
    !Number.isInteger(header.frames) || header.frames < 1
  ) {
    throw new Error(`${path}: poses header is missing clipId/frames/jointNames`);
  }
  const blob = bytes.slice(nl + 1); // fresh, 4-aligned buffer
  const expected = header.frames * header.jointNames.length * 16 * 4;
  if (blob.byteLength !== expected) {
    throw new Error(`${path}: blob ${blob.byteLength} B, expected ${expected}`);
  }
  return { header, data: new Float32Array(blob.buffer, 0, expected / 4) };
}
