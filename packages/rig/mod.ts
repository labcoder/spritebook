/**
 * @spritebook/rig — Track B rigging in core (P3-T3).
 *
 * The licence boundary schema/rig.ts describes lands here: an auto-rig adapter
 * runs bpy inside the sidecar and returns NEUTRAL data (`rig.json` +
 * `rig.npz`), and this package turns that data into a real glTF skin, checks
 * numerically that the result deforms, and carries the orientation repairs.
 * Everything crosses as file paths (D-004); no GPU and no Blender in our path.
 *
 *   applyRig         neutral rig data + canonical mesh -> rigged glb
 *   deformCheck      rigged glb -> per-joint deviation report (DeformReport)
 *   detectFacing     which way this geometry faces, and the verb that fixes it
 *   applyJointEdits  tier-1 joint nudges, replayable as re-run hints
 */
export {
  applyRig,
  BONE_EPS_M,
  boneRotation,
  IBM_IDENTITY_TOLERANCE,
  NEGATIVE_WEIGHT_EPS,
  packWeightRows,
  RIG_SKIN_NAME,
  WEIGHT_SUM_EPS,
  WEIGHT_SUM_TOLERANCE,
  ZERO_WEIGHT_EPS,
} from './apply.ts';
export type { ApplyRigOptions, ApplyRigResult } from './apply.ts';

export {
  boneDirection,
  DEAD_JOINT_EPS_M,
  DEFAULT_ANGLE_DEG,
  DEFAULT_STRETCH_THRESHOLD,
  DEFAULT_WEIGHT_FLOOR,
  DEFORM_REPORT_FILE,
  deformCheck,
  dominantPerpendicularAxis,
  uniqueEdges,
} from './deform.ts';
export type { DeformCheckOptions } from './deform.ts';

export { isIntegerDType, parseNpy, readNpz, readNpzFile } from './npz.ts';
export type { NpyArray, NpyData, NpyDType } from './npz.ts';

export {
  documentToRiggedAsset,
  loadRiggedAsset,
  restWorlds,
  skinAll,
  skinMatrices,
  skinVertex,
} from './skin.ts';
export type { Mat4, RiggedAsset } from './skin.ts';

export {
  applyOrientationFixes,
  boundsOf,
  detectFacing,
  detectFacingFile,
  fixFor,
  worldPositions,
} from './orient.ts';

export { applyEditsToRiggedGlb, applyJointEdits, hintsFromEdits, sidePartner } from './edits.ts';
export type { ApplyEditsResult } from './edits.ts';

export { runRigJob } from './job.ts';
export type { RigJobOptions, RigJobSummary } from './job.ts';

/**
 * Track A (P3-T4): ONE canonical rigged humanoid fitted to each generated
 * mesh, so a hundred characters share a skeleton, a UV layout and an animation
 * binding — the roster fast path that needs no GPU at all.
 *
 *   buildCanonicalBody  a UAL-skeleton rigged glb -> body.glb + body.json
 *   fitCanonicalBody    canonical body + target mesh -> fitted rigged glb
 */
export {
  assertRestRoundTrip,
  BAND_MIN_VERTICES,
  bandScale,
  BODY_REGIONS,
  buildCanonicalBody,
  closestOnTriangle,
  CUTOFF_FRACTION,
  FIT_BANDS,
  fitCanonicalBody,
  readSurface,
  REST_ROUNDTRIP_TOLERANCE_M,
  SNAP_FRACTION,
  STRAY_TOLERANCE_FRACTION,
  TriangleGrid,
} from './fit.ts';
export type {
  BuildCanonicalBodyOptions,
  BuildCanonicalBodyResult,
  FitCanonicalBodyOptions,
  FitReport,
  Surface,
} from './fit.ts';
