/**
 * Frozen internal contracts for @spritebook/anim (P3-T1). The animation module
 * turns pack clips into POSES the renderer plays — retarget ONCE (D-006),
 * sample per ClipBinding, write a poses artifact; the render seam consumes the
 * file by PATH (D-004: inputs are paths + plain data, never live objects).
 *
 * THE POSES SEAM (the load-bearing contract): a poses file carries per-frame
 * joint LOCAL matrices for a named skeleton. Poses are direction-INDEPENDENT
 * (the camera orbits; the pose does not), so one file serves every direction.
 * Renderer maps `jointNames` -> its skinned asset's joints BY NAME at load, so
 * joint order never has to agree across tools. Preview GLBs and poses files are
 * emitted from the SAME sampled matrices — that is what makes the P3-T1
 * preview/bake parity acceptance true by construction (then asserted anyway).
 *
 * Format `poses-<clipId>.bin`: one UTF-8 JSON header line (canonical: sorted
 * keys, compact) + '\n' + a little-endian Float32 blob, frames-major:
 *   data[frame][joint][16]  — column-major mat4 LOCAL joint matrices.
 * Header: { clipId, frames, jointNames, version: 1 }.
 *
 * SAMPLING SEMANTICS (ClipBinding: frames N, speed s, holdLast):
 *   duration' = duration / s
 *   loop (holdLast=false): t_i = (i / N) * duration'      — exclusive end; frame
 *     N would wrap to frame 0, so a loop never duplicates its first pose.
 *   holdLast=true:        t_i = min(i * duration'/(N-1), duration') — the last
 *     frame lands exactly on the final pose.
 * Interpolation: LINEAR (slerp for rotations, lerp T/S) and STEP supported;
 * CUBICSPLINE is an actionable error (no silent fallback).
 */
import type { Document } from '@gltf-transform/core';

// ---------------------------------------------------------------------------
// The humanoid profile (profile.ts — Agent A). UE-style joint names as shipped
// by Quaternius UAL (verified 2026-07-18 on the maintainer's download: 65
// joints, identical across UAL1/UAL2/Mannequin_F).
// ---------------------------------------------------------------------------
export interface HumanoidProfile {
  id: 'ual-humanoid';
  /** joints REQUIRED for retargeting (missing on target -> reported, at rest) */
  core: readonly string[];
  /** optional joints (fingers etc.) — mapped when present, silent when absent */
  extended: readonly string[];
  /**
   * explicit side anchors (animation-retargeting skill: side assignment from
   * geometry alone ties itself to float noise) — name pairs, left first
   */
  sidePairs: ReadonlyArray<readonly [string, string]>;
  /** the hips/root-motion joint and the ground-contact joints */
  hips: string;
  feet: readonly string[];
}

/** Per-joint mapping outcome; `unmapped` is a report, never a guess. */
export interface MappingReport {
  mapped: string[];
  /** target joints with no source track — left at rest */
  unmappedTarget: string[];
  /** source tracks with no target joint — dropped */
  unmappedSource: string[];
}

// ---------------------------------------------------------------------------
// The in-memory clip representation (source-skeleton OR retargeted-to-target).
// Tracks are keyed by JOINT NAME; times are seconds ascending; rotations are
// unit quaternions [x,y,z,w]; translations/scales optional (rest value when
// absent). This is what sample.ts consumes and retarget.ts produces.
// ---------------------------------------------------------------------------
export interface JointTrack {
  times: Float32Array;
  /** frames x 4, quaternion per keyframe */
  rotations?: Float32Array;
  /** frames x 3 */
  translations?: Float32Array;
  /** frames x 3 */
  scales?: Float32Array;
  interpolation: 'LINEAR' | 'STEP';
}

export interface Clip {
  id: string;
  duration: number;
  tracks: Map<string, JointTrack>;
}

/** Load a named animation from a glTF Document into a Clip (pack.ts / anim IO). */
export type LoadClip = (doc: Document, animationName: string, clipId: string) => Clip;

// ---------------------------------------------------------------------------
// Retarget (retarget.ts — Agent A). Pure function of (source clip on the
// profile skeleton, target skeleton rest pose, profile). Laws in the
// animation-retargeting skill: world-orientation transfer through rest-pose
// deltas, hips-only translation scaled by leg-length ratio, foot-ground
// correction pass, never guess unmapped joints.
// ---------------------------------------------------------------------------
export interface SkeletonRest {
  /** joint name -> parent name ('' for roots) */
  parents: Map<string, string>;
  /** joint name -> column-major local rest matrix (16) */
  locals: Map<string, Float32Array>;
}

export interface RetargetResult {
  clip: Clip; // on the TARGET skeleton, ready for sample.ts
  report: MappingReport;
  /** numeric validation evidence (skill: numbers first) */
  stats: {
    /** max |foot height| on contact frames after correction, meters */
    footContactMaxErrM: number;
    /** hip trajectory scale applied (target legLen / source legLen) */
    hipScale: number;
  };
}

// ---------------------------------------------------------------------------
// Poses file (sample.ts + IO — integrator)
// ---------------------------------------------------------------------------
export interface PosesHeader {
  clipId: string;
  frames: number;
  jointNames: string[];
  version: 1;
}

export const POSES_VERSION = 1;

export function posesFileName(clipId: string): string {
  return `poses-${clipId}.bin`;
}

// ---------------------------------------------------------------------------
// Pack layout (pack.ts — Agent B). A pack is a directory:
//   pack.json            AnimPackSchema (in @spritebook/schema) — id, license,
//                        redistributable, skeleton, clips w/ tags+category
//   clips/<clipId>.glb   one glb per clip (skeleton + single animation)
// The bundled UAL pack is BUILT (never committed raw) by the build script from
// the maintainer's local download; CC0 makes the converted output committable.
// User imports (personal Mixamo) get redistributable: false and are NEVER
// bundled (D-013).
// ---------------------------------------------------------------------------
export const PACK_MANIFEST = 'pack.json';
export const PACK_CLIP_DIR = 'clips';
