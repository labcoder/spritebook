/**
 * SpriteBook data models — draft v0.2 (2026-07-11)
 *
 * Merged from: v0 draft + UX deltas + pre-regen audit.
 * P1-T2 turns this file into `packages/schema` with runtime validation
 * (Zod or similar), migrations, and exhaustive tests. Until then this
 * draft is the contract of record; keep it in lockstep with architecture.md.
 *
 * Conventions: all lengths in meters, all angles in degrees, all times in
 * seconds unless suffixed. Hashes are sha256 hex. IDs are lowercase slugs.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Immutable, minted at creation. Binds cache keys, file paths, CLI targets. */
export type CharacterId = string; // slug: /^[a-z0-9][a-z0-9-]{1,40}$/
export type ProjectId = string;
export type JobId = string;
export type BakeId = string; // short hash, e.g. "e41c"

// ---------------------------------------------------------------------------
// Registry (D-009): catalog → installed → pins. Backends AND animation packs.
// ---------------------------------------------------------------------------

export type JSONSchema = Record<string, unknown>; // draft 2020-12 subset

export interface LicenseInfo {
  spdx?: string;                 // "MIT", "Apache-2.0", "CC0-1.0"
  name: string;                  // display, e.g. "Tencent Community License"
  url?: string;
  requiresAcceptance: boolean;   // shown in the install gate
  excludedTerritories?: string[]; // ISO codes; e.g. Hunyuan3D: ["EU","GB","KR"]
}

export interface ModelVersion {
  version: string;               // "1.2"
  weightsUrl: string;
  weightsSha256: string;         // exact pin; staged releases are why (UniRig)
  diskBytes: number;
  minVramGb?: number;
  /** JSON Schema for adapter params — validates GenerationParams AND drives
   *  the GUI options form. Pixal3D: quality/textureSize; TripoSplat: gaussians. */
  paramsSchema: JSONSchema;
  defaults: Record<string, unknown>;
  /** What the backend emits; geometry-only backends trigger the texture substage. */
  outputs: { geometry: true; texture: boolean; kind: 'mesh' | 'gaussians' };
}

export interface ModelEntry {
  id: string;                    // "pixal3d"
  kind: 'gen3d' | 'rig' | 'imageprep';
  displayName: string;
  license: LicenseInfo;
  versions: ModelVersion[];
  notes?: string;                // "pixel-aligned — best for fine detail"
}

export interface AnimationPack {
  id: string;                    // "ual-free", "mesh2motion", "user-<slug>"
  displayName: string;
  license: LicenseInfo;          // CC0 for bundled; user imports keep origin
  rigProfile: 'ual-humanoid' | 'mixamo' | 'custom';
  bundled: boolean;              // bundled packs are redistributable; imports never are
  clips: AnimationClip[];
}

export interface AnimationClip {
  id: string;                    // "walk_relaxed"
  packId: string;
  displayName: string;
  durationS: number;
  fpsSource: number;
  category: 'locomotion' | 'idle' | 'emote' | 'combat' | 'work' | 'other';
  tags: string[];                // searchable
  rootMotion: boolean;
  loop: boolean;
}

export interface ProjectPins {
  models: Record<string, string>;      // "pixal3d" → "1.2"
  packs: Record<string, string>;
  rendererVersion: string;             // participates in every cache key
}

// ---------------------------------------------------------------------------
// Project & presets
// ---------------------------------------------------------------------------

export interface Project {
  id: ProjectId;
  name: string;
  pins: ProjectPins;
  cameraPresets: CameraPreset[];
  stylePresets: StylePreset[];
  defaults: { cameraPresetId: string; stylePresetId: string; exportTargets: ExportTargetId[] };
}

export interface CameraPreset {
  id: string;                    // "topdown30x8"
  elevationDeg: number;          // detents: 15 | 26.565 (2:1) | 30 | 35.264 (iso)
  directions: 2 | 4 | 8 | 16;
  yawOffsetDeg: number;          // direction 0 faces camera at yaw 0 (+Z front)
  pixelsPerMeter: number;        // world-locked scale: roster shares one ruler
  cellPx: { w: number; h: number };
  paddingPx: number;             // must exceed outline width (validated)
  pivot: 'feet-baseline' | 'center' | { xPct: number; yPct: number };
  orthographic: true;
}

export interface StylePreset {
  id: string;                    // "cel-2"
  mode: 'cel' | 'pixel' | 'painterly';
  ramp?: { stops: number; rimStrength: number };
  quantize?: {
    palette: 'adaptive' | string[];   // adaptive = per-character, all frames, once
    maxColors: number;
    space: 'oklab';
    dither: { kind: 'ordered'; matrix: 4 | 8; strength: number } | { kind: 'none' };
  };
  outline?: { widthPx: number; normalThreshold: number; depthThresholdScaled: number; colorFrom: 'palette-dark' | string };
  temporal: { superSample: 1 | 2 | 3 | 4; clusterVote: boolean; paletteHysteresisEps: number; texelSnap: boolean };
  passes: Array<'lit' | 'albedo' | 'normal' | 'depth' | 'mask'>;
  alpha: { mode: '1bit' | 'soft'; cutoff?: number; bleedPx: number };
}

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------

export interface CharacterManifest {
  id: CharacterId;               // immutable — see Identity
  displayName: string;           // mutable; `spritebook rename` touches only this
  createdAt: string;             // ISO
  source: SourceRecord;
  preflight?: PreflightReport;
  generation: { results: GenerationResult[]; pickedResultId?: string };
  canonicalMesh?: { gltfSha256: string; heightM: number; texturedBy: 'backend' | 'texture-substage'; reprojected: boolean };
  rig?: RigState;
  animationSet?: ClipBinding[];
  look?: { cameraPresetId: string; stylePresetId: string; overrides?: Partial<StylePreset> };
  mirroring: { enabled: boolean };     // OPT-IN (D-008): asymmetry is first-class
  detailLayers?: DetailLayer[];        // UV-space decals: tattoos, marks
  attachments?: Attachment[];          // socketed props: prosthetics, tools
  lastBakeId?: BakeId;
}

export interface SourceRecord {
  kind: 'image' | 'mesh';
  originalFilename: string;
  sha256: string;
  importedVia?: { tool: 'gltf-transform' | 'ufbx' | 'obj2gltf'; version: string };
}

export interface PreflightReport {
  at: string;
  checks: Array<{
    id: 'loaded' | 'cutout' | 'pose' | 'resolution' | string;
    status: 'ok' | 'warn' | 'fail' | 'pending';
    message: string;             // sentence case, advisory tone
    fixApplied?: string;
  }>;
}

/** Pre-canonical working set: every generation attempt is a receipt. */
export interface GenerationResult {
  id: string;                    // "r1"
  backend: { modelId: string; version: string };
  params: Record<string, unknown>;   // validated against paramsSchema
  seed: number;                  // recorded provenance — "re-run exactly this"
  startedAt: string;
  wallTimeS: number;
  output: { gltfSha256: string; tris: number; textureRes?: number; kind: 'mesh' | 'gaussians' };
  discarded: boolean;
}

export interface RigState {
  track: 'A' | 'B';
  backend?: { modelId: string; version: string };  // Track B
  skeletonProfile: 'ual-humanoid' | 'generic';
  jointCount: number;
  /** Tier-1 repairs: recorded patch, replayable, feeds re-run hints. */
  jointEdits: Array<{ joint: string; delta: [number, number, number]; mirrored: boolean }>;
  /** Tier-2 structural fixes, recorded for provenance. */
  orientationFixes: Array<'face-front' | 'feet-ground' | 'center' | `rotate-${90 | 180 | 270}`>;
  boneMask?: Record<string, string>;   // Track A identity regions
  sockets?: Array<{ id: string; bone: string; localOffset: number[] }>;
  accepted: boolean;
}

export interface ClipBinding {
  clipId: string;
  packId: string;
  enabled: boolean;
  frames: number;                // sampled per direction
  speed: number;                 // 1.0 = source
  holdLast: boolean;
}

export interface DetailLayer { id: string; uvDecalPng: string; region?: string }
export interface Attachment { id: string; socketId: string; meshSha256: string }

// ---------------------------------------------------------------------------
// Bake (D-010): canonical output; exporters are projections
// ---------------------------------------------------------------------------

export interface BakeManifest {
  bakeId: BakeId;
  characterId: CharacterId;
  inputs: CacheKeyInputs;        // the full recipe, embedded for provenance
  frames: FrameRecord[];
  atlases: AtlasPage[];
  metrics: BakeMetrics;          // audit item 4
  flags: QAFlag[];               // audit item 3
  createdAt: string;
}

export interface FrameRecord {
  clipId: string;
  direction: number;             // index into CameraPreset.directions
  frame: number;
  pivotPx: { x: number; y: number };
  atlas: { pageIndex: number; x: number; y: number; w: number; h: number };
  cacheHit: boolean;
  mirroredFrom?: { direction: number };  // present only when mirroring enabled
}

export interface AtlasPage {
  pageIndex: number;
  pass: 'lit' | 'albedo' | 'normal' | 'depth' | 'mask';
  sizePx: number;                // 2048
  png: string;                   // path
  /** Parallel-layout law: AOV pages share rects with the lit page. */
  layoutSharedWith: 'lit';
}

export interface BakeMetrics {
  flickerPct: number;            // idle-loop changed px/frame; budget per preset
  cacheHitPct: number;
  wallTimeS: number;
  framesTotal: number;
}

export interface QAFlag {
  code: 'outline-exceeds-padding' | 'alpha-clipped' | 'palette-overflow' | string;
  severity: 'warn' | 'error';
  sourceStage: 'look' | 'rig' | 'anim' | 'bake';   // powers "Open <stage> at flag"
  frameRefs: Array<{ clipId: string; direction: number; frame: number }>;
  message: string;
}

// ---------------------------------------------------------------------------
// Cache (D-011): hash inputs, never pixels; bind to characterId
// ---------------------------------------------------------------------------

export interface CacheKeyInputs {
  characterId: CharacterId;      // NEVER displayName
  canonicalMeshSha256: string;
  rigStateHash: string;          // incl. jointEdits + orientationFixes
  clipBindingHash: string;
  cameraPresetHash: string;
  stylePresetHash: string;
  rendererVersion: string;
  backend: { modelId: string; version: string; paramsHash: string };
}

// ---------------------------------------------------------------------------
// Jobs & events — the NDJSON contract (log drawer renders this verbatim)
// ---------------------------------------------------------------------------

export interface JobSpec {
  jobId: JobId;
  verb: 'prep' | 'gen' | 'pick' | 'rig' | 'anim' | 'bake' | 'export' | 'models';
  characterId?: CharacterId;
  payload: Record<string, unknown>;
}

export type JobEvent =
  | { t: 'queued'; jobId: JobId; at: string }
  | { t: 'started'; jobId: JobId; at: string }
  | { t: 'progress'; jobId: JobId; at: string; step: string; done: number; total: number }
  | { t: 'artifact'; jobId: JobId; at: string; kind: string; path: string }
  | { t: 'warn'; jobId: JobId; at: string; code: string; message: string }
  | { t: 'error'; jobId: JobId; at: string; code: string; message: string; retryable: boolean }
  | { t: 'done'; jobId: JobId; at: string; wallTimeS: number };

// ---------------------------------------------------------------------------
// Undo (law 7): every mutation is a journaled, reversible patch
// ---------------------------------------------------------------------------

export interface ManifestPatch {
  seq: number;
  at: string;
  target: { kind: 'character' | 'project'; id: string };
  op: JsonPatchOp[];             // RFC-6902 subset
  inverse: JsonPatchOp[];        // precomputed at apply time
  label: string;                 // "Nudge shoulder_L", "Enable walk_relaxed"
}
export interface JsonPatchOp { op: 'add' | 'remove' | 'replace'; path: string; value?: unknown }

// ---------------------------------------------------------------------------
// Machine-local GUI prefs — never in the project manifest
// ---------------------------------------------------------------------------

export interface UiLayoutPrefs {
  theme: 'dark' | 'light' | 'system';
  panels: Record<string, { widthPx?: number; collapsed?: boolean }>;
  logDrawer: { heightPx: number; filter: 'all' | 'warn' | 'error' };
  stageRailCollapsed: boolean;
}
