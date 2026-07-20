/**
 * Fixture generator: builds one full-featured valid document per entity from
 * typed literals, validates it, and writes CANONICAL bytes. Deterministic —
 * rerunning must produce identical files.
 *
 *   deno run --allow-write packages/schema/fixtures/_generate.ts
 */
import { canonicalJson, parseWith } from '../canonical.ts';
import { ModelEntrySchema } from '../registry.ts';
import { AnimationPackSchema } from '../registry.ts';
import { ProjectSchema } from '../project.ts';
import { CharacterManifestSchema } from '../character.ts';
import { BakeManifestSchema } from '../bake.ts';
import { CacheKeyInputsSchema } from '../cache.ts';
import { ManifestPatchSchema } from '../patch.ts';
import { UiLayoutPrefsSchema } from '../prefs.ts';
import { JobEventSchema } from '../jobs.ts';

const sha = (c: string) => c.repeat(64);
const T0 = '2026-07-12T00:00:00Z';

const modelEntry = parseWith(ModelEntrySchema, {
  id: 'pixal3d',
  kind: 'gen3d',
  displayName: 'Pixal3D',
  license: { spdx: 'MIT', name: 'MIT', requiresAcceptance: false },
  versions: [{
    version: '1.2',
    files: [{
      path: 'pixal3d-1.2.safetensors',
      url: 'https://example.com/pixal3d-1.2.safetensors',
      sha256: sha('a'),
      bytes: 4200000000,
    }],
    platforms: ['windows-cuda', 'linux-cuda'],
    minVramGb: 8,
    paramsSchema: { type: 'object', properties: { quality: { type: 'string' } } },
    defaults: { quality: 'high' },
    outputs: { geometry: true, texture: true, kind: 'mesh' },
  }],
  notes: 'pixel-aligned - best for fine detail',
}, 'ModelEntry fixture');

const animationPack = parseWith(AnimationPackSchema, {
  id: 'ual-free',
  displayName: 'Universal Animation Library (free tier)',
  license: { spdx: 'CC0-1.0', name: 'CC0', requiresAcceptance: false },
  rigProfile: 'ual-humanoid',
  bundled: true,
  clips: [{
    id: 'walk_relaxed',
    packId: 'ual-free',
    displayName: 'Walk (relaxed)',
    durationS: 1.667,
    fpsSource: 24,
    category: 'locomotion',
    tags: ['walk', 'loop'],
    rootMotion: true,
    loop: true,
  }],
}, 'AnimationPack fixture');

const cameraPreset = {
  id: 'topdown30x8',
  elevationDeg: 30,
  directions: 8,
  yawOffsetDeg: 0,
  pixelsPerMeter: 48,
  cellPx: { w: 128, h: 128 },
  paddingPx: 4,
  pivot: 'feet-baseline',
  orthographic: true,
} as const;

const stylePreset = {
  id: 'cel-2',
  mode: 'cel',
  ramp: { stops: 2, rimStrength: 0.35 },
  quantize: {
    palette: 'adaptive',
    maxColors: 24,
    space: 'oklab',
    dither: { kind: 'ordered', matrix: 4, strength: 0.4 },
  },
  outline: {
    widthPx: 2,
    normalThreshold: 0.4,
    depthThresholdScaled: 0.02,
    colorFrom: 'palette-dark',
  },
  temporal: { superSample: 2, clusterVote: true, paletteHysteresisEps: 0.02, texelSnap: true },
  passes: ['lit', 'normal', 'depth', 'mask'],
  alpha: { mode: '1bit', cutoff: 0.5, bleedPx: 2 },
} as const;

const project = parseWith(ProjectSchema, {
  schemaVersion: 2,
  id: 'greenfields',
  name: 'Greenfields',
  pins: {
    models: { pixal3d: '1.2' },
    packs: { 'ual-free': '1.0' },
    rendererVersion: '0.1.0',
  },
  cameraPresets: [cameraPreset],
  stylePresets: [stylePreset],
  defaults: {
    cameraPresetId: 'topdown30x8',
    stylePresetId: 'cel-2',
    exportTargets: ['godot', 'aseprite'],
  },
}, 'Project fixture');

const cacheKeyInputs = parseWith(CacheKeyInputsSchema, {
  characterId: 'brave-knight',
  canonicalMeshSha256: sha('b'),
  rigStateHash: sha('c'),
  clipBindingHash: sha('d'),
  cameraPresetHash: sha('e'),
  stylePresetHash: sha('f'),
  rendererVersion: '0.1.0',
  backend: { modelId: 'pixal3d', version: '1.2', paramsHash: sha('0') },
}, 'CacheKeyInputs fixture');

const characterManifest = parseWith(CharacterManifestSchema, {
  schemaVersion: 2,
  id: 'brave-knight',
  displayName: 'Brave Knight',
  createdAt: T0,
  source: {
    kind: 'image',
    originalFilename: 'knight-ref.png',
    sha256: sha('1'),
  },
  preflight: {
    at: T0,
    checks: [
      { id: 'cutout', status: 'ok', message: 'Background removed cleanly' },
      { id: 'pose', status: 'warn', message: 'Arms close to torso; A-pose preferred' },
    ],
  },
  generation: {
    results: [{
      id: 'r1',
      backend: { modelId: 'pixal3d', version: '1.2' },
      params: { quality: 'high' },
      seed: 42,
      startedAt: T0,
      wallTimeS: 92.5,
      output: { gltfSha256: sha('2'), tris: 14318, textureRes: 1024, kind: 'mesh' },
      discarded: false,
    }],
    pickedResultId: 'r1',
  },
  canonicalMesh: {
    gltfSha256: sha('b'),
    heightM: 1.81,
    texturedBy: 'backend',
    reprojected: false,
  },
  rig: {
    track: 'B',
    backend: { modelId: 'unirig', version: '1.0' },
    skeletonProfile: 'generic',
    jointCount: 52,
    jointEdits: [{ joint: 'shoulder_l', delta: [0, 0.01, 0], mirrored: false }],
    orientationFixes: ['face-front', 'feet-ground'],
    sockets: [{ id: 'hand-r', bone: 'hand_r', localOffset: [0, 0, 0.05] }],
    accepted: true,
  },
  animationSet: [{
    clipId: 'walk_relaxed',
    packId: 'ual-free',
    enabled: true,
    frames: 8,
    speed: 1,
    holdLast: false,
  }],
  look: {
    cameraPresetId: 'topdown30x8',
    stylePresetId: 'cel-2',
    overrides: { alpha: { mode: '1bit', cutoff: 0.4, bleedPx: 2 } },
  },
  mirroring: { enabled: false },
  detailLayers: [{ id: 'scar', uvDecalPng: 'decals/scar.png', region: 'face' }],
  attachments: [{ id: 'sword', socketId: 'hand-r', meshSha256: sha('3') }],
  lastBakeId: 'e41c',
}, 'CharacterManifest fixture');

const bakeManifest = parseWith(BakeManifestSchema, {
  schemaVersion: 2,
  bakeId: 'e41c',
  characterId: 'brave-knight',
  inputs: cacheKeyInputs,
  frames: [{
    clipId: 'walk_relaxed',
    direction: 0,
    frame: 0,
    pivotPx: { x: 64, y: 120 },
    atlas: { pageIndex: 0, x: 0, y: 0, w: 128, h: 128 },
    cacheHit: false,
  }, {
    clipId: 'walk_relaxed',
    direction: 4,
    frame: 0,
    pivotPx: { x: 64, y: 120 },
    atlas: { pageIndex: 0, x: 128, y: 0, w: 128, h: 128 },
    cacheHit: true,
    mirroredFrom: { direction: 0 },
  }],
  atlases: [
    { pageIndex: 0, pass: 'lit', sizePx: 2048, png: 'atlas-0-lit.png', layoutSharedWith: 'lit' },
    {
      pageIndex: 0,
      pass: 'normal',
      sizePx: 2048,
      png: 'atlas-0-normal.png',
      layoutSharedWith: 'lit',
    },
  ],
  metrics: { flickerPct: 0.8, cacheHitPct: 50, wallTimeS: 12.25, framesTotal: 2 },
  flags: [{
    code: 'outline-exceeds-padding',
    severity: 'warn',
    sourceStage: 'look',
    frameRefs: [{ clipId: 'walk_relaxed', direction: 0, frame: 0 }],
    message: 'Outline width 2 px meets padding 4 px on tight frames',
  }],
  createdAt: T0,
}, 'BakeManifest fixture');

const manifestPatch = parseWith(ManifestPatchSchema, {
  seq: 12,
  at: T0,
  target: { kind: 'character', id: 'brave-knight' },
  op: [{ op: 'replace', path: '/displayName', value: 'Sir Bravery' }],
  inverse: [{ op: 'replace', path: '/displayName', value: 'Brave Knight' }],
  label: 'Rename to Sir Bravery',
}, 'ManifestPatch fixture');

const uiLayoutPrefs = parseWith(UiLayoutPrefsSchema, {
  theme: 'dark',
  panels: { inspector: { widthPx: 320 }, library: { collapsed: true } },
  logDrawer: { heightPx: 220, filter: 'warn' },
  stageRailCollapsed: false,
}, 'UiLayoutPrefs fixture');

const jobEvents = [
  { t: 'queued', jobId: 'job-1', at: T0 },
  { t: 'started', jobId: 'job-1', at: T0 },
  { t: 'progress', jobId: 'job-1', at: T0, step: 'render', done: 1, total: 16 },
  { t: 'artifact', jobId: 'job-1', at: T0, kind: 'atlas', path: 'atlas-0-lit.png' },
  { t: 'warn', jobId: 'job-1', at: T0, code: 'palette-overflow', message: 'Palette clamped to 24' },
  {
    t: 'error',
    jobId: 'job-1',
    at: T0,
    code: 'device-lost',
    message: 'GPU device lost',
    retryable: true,
  },
  { t: 'done', jobId: 'job-1', at: T0, wallTimeS: 12.25 },
].map((e) => parseWith(JobEventSchema, e, 'JobEvent fixture'));

// v1 migration input: no schemaVersion, no mirroring (pre-D-008 document)
const characterV1 = (() => {
  const { schemaVersion: _v, mirroring: _m, ...rest } = characterManifest;
  return rest;
})();

const here = new URL('.', import.meta.url);
const write = (rel: string, content: string) => Deno.writeTextFile(new URL(rel, here), content);

await Deno.mkdir(new URL('valid/', here), { recursive: true });
await Deno.mkdir(new URL('migrate/', here), { recursive: true });
await write('valid/model-entry.json', canonicalJson(modelEntry));
await write('valid/animation-pack.json', canonicalJson(animationPack));
await write('valid/project.json', canonicalJson(project));
await write('valid/character-manifest.json', canonicalJson(characterManifest));
await write('valid/bake-manifest.json', canonicalJson(bakeManifest));
await write('valid/cache-key-inputs.json', canonicalJson(cacheKeyInputs));
await write('valid/manifest-patch.json', canonicalJson(manifestPatch));
await write('valid/ui-layout-prefs.json', canonicalJson(uiLayoutPrefs));
await write('valid/job-events.ndjson', jobEvents.map((e) => canonicalJson(e)).join(''));
await write('migrate/character.v1.json', canonicalJson(characterV1));
console.log('fixtures written (canonical bytes)');
