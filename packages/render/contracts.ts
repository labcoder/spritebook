/**
 * Frozen internal contracts for @spritebook/render (P2-T1). These are the
 * interlocks every internal module builds against so the package composes
 * byte-exactly across host code and WGSL. NONE of this crosses the D-004 seam:
 * the seam is mod.ts, and it speaks only file paths + JobEvents.
 *
 * Repo-wide conventions (P0-T2 spike + webgpu-headless-rendering skill):
 *  - mat4 = Float32Array(16), COLUMN-MAJOR (WebGPU/glTF).
 *  - Right-handed view space (camera looks down -Z); WebGPU clip z in [0, 1].
 *  - Shade in linear; apply the sRGB encode EXACTLY ONCE, in the lit AOV.
 *  - vec3 aligns to 16 bytes inside WGSL uniform/storage structs — pad to vec4.
 */
import type { CameraPreset, RenderPass } from '@spritebook/schema';

// ---------------------------------------------------------------------------
// The seam spec (plain data in; files + events out). Core resolves the preset
// id against the project manifest and passes the resolved CameraPreset as
// plain data — a future `renderd` subprocess receives the identical JSON.
// ---------------------------------------------------------------------------
export interface RenderJobSpec {
  jobId: string;
  /** canonical glb produced by the importer border (a path, always) */
  modelPath: string;
  /** resolved plain data (schema-validated by core before it crosses) */
  camera: CameraPreset;
  /** frames to render (with `posesPath`: must equal the poses file's frame count) */
  frames: number;
  /**
   * pose source: the deterministic test poses ('turntable' default; 'idle' is
   * the low-motion flicker loop), or 'clip' — play the poses artifact at
   * `posesPath` (P3-T1: anim samples ClipBindings into per-frame joint local
   * matrices, keyed by joint NAME; the renderer maps names -> its skin's joints
   * at load). A file path across the seam, per D-004.
   */
  pose?: 'turntable' | 'idle' | 'clip';
  /** required when pose === 'clip': the poses-<clipId>.bin artifact */
  posesPath?: string;
  /**
   * Render ONLY these direction indices (into the camera preset's ring), in
   * this order. Omitted = every direction, which is the normal case.
   *
   * Exists for D-008 mirroring: half the directions are horizontal flips of
   * the other half, and flipping is nearly free while rendering is not — so
   * the saving has to be taken HERE or it is not a saving at all. The subset
   * is validated against the preset's direction count, because a silently
   * dropped direction is a hole in a sprite sheet nobody notices until the
   * character teleports.
   */
  directionSubset?: number[];
  /** carried through; the NPR style stack is P2-T2 */
  stylePreset: string;
  /** every render product is written under here */
  outDir: string;
}

// ---------------------------------------------------------------------------
// Framing solver (camera.ts) — pure, GPU-free, unit-testable without an adapter
// ---------------------------------------------------------------------------
export interface ModelBounds {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

export interface DirectionCamera {
  dirIndex: number;
  yawDeg: number;
  /** column-major view matrix */
  view: Float32Array;
  /** column-major orthographic projection */
  proj: Float32Array;
  /** near/far bracketing the model, for the linearized-depth AOV */
  near: number;
  far: number;
}

export interface FramingResult {
  cameras: DirectionCamera[];
  /**
   * World-locked framing ⇒ the pivot lands on the SAME pixel in every
   * direction. Feeds FrameRecord.pivotPx (schema) at pack time.
   */
  pivotPx: { x: number; y: number };
  /**
   * 1 / preset.pixelsPerMeter. One world metre is always pixelsPerMeter px
   * HORIZONTALLY; vertically the ortho camera foreshortens by cos(elevation)
   * (measured 0.112 px/m at 89.9 degrees). camera.ts carries the full caveat —
   * this line used to state the horizontal case as if it held on both axes.
   */
  metersPerPixel: number;
}

/**
 * Resolve a CameraPreset + model bounds into per-direction ortho cameras and
 * the shared pivot pixel. Pure function of its inputs — no wall clock, no GPU,
 * no globals — so the structural golden suite runs it anywhere.
 */
export type SolveFraming = (preset: CameraPreset, bounds: ModelBounds) => FramingResult;

// ---------------------------------------------------------------------------
// GPU context (gpu.ts)
// ---------------------------------------------------------------------------
export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  adapterInfo: Record<string, unknown>;
  features: string[];
  /** set by the device.lost handler; a bake job converts this to a retryable error */
  lost: { reason: string; message: string } | null;
}

// Limits we actually depend on (skill: request what you use, don't trust defaults).
export const REQUIRED_LIMITS: Record<string, number> = {
  maxColorAttachments: 5,
};

/**
 * The render pipeline's version, OWNED HERE (P2-T4; previously mis-homed in
 * pack). Bump policy (docs/versioning.md): bump on ANY pixel-affecting change
 * anywhere in the bake pipeline — shaders, framing, pose driver, AOV encoding,
 * style algorithms, packing — because this string anchors every cache key and
 * golden set. A bump ships with a golden refresh explaining why pixels changed.
 * Cache keys never carry this string raw: they carry renderSignature()
 * (diagnostics.ts), which composes it with the adapter-identity hash (D-023) so
 * an ADAPTER change is an honest cache miss (driver-version-only updates are a
 * known gap — see diagnostics.ts).
 */
// 0.5.0: the ambient floor moves 0.12 -> 0.30 (renderer.ts AMBIENT). Every
// baked pixel changes, so this bump is what makes every existing cache entry
// and every golden an honest miss rather than a silent disagreement.
// 0.4.0: materials honoured (factor x texture, alpha cutout); median cut
// reaches maxColors DISTINCT colours; area average weights colour by coverage.
export const RENDERER_VERSION = 'spritebook-render@0.5.0';

// ---------------------------------------------------------------------------
// AOV contract (aov.ts + shaders.wgsl). One MRT pass, five color attachments,
// in this exact order — the FS output struct @location(0..4) must match.
// maxColorAttachmentBytesPerSample charges rgba8unorm at 8 B each (NOT 4) and r32
// targets at 4 B, so these five sum to 8+8+8+4+4 = 32 B — exactly the guaranteed
// floor. (Every cost is a multiple of the 4-byte max alignment, so the running
// total never needs padding and ANY permutation also totals 32 — the byte budget
// does not constrain the order.) The order is still load-bearing, but because
// AOV_TARGETS is the single source of truth tying the FS @location(0..4) outputs
// to the pipeline targets, the textures, the readback loop, and the PNG encoders:
// reordering silently mismatches AOV identity. Do NOT reorder. (Hardware-verified.)
// ---------------------------------------------------------------------------
export interface AovTarget {
  pass: RenderPass;
  format: GPUTextureFormat;
  /** bytes per pixel on readback */
  bpp: number;
  /** how png.ts encodes it */
  encode: 'rgba8' | 'gray16' | 'u32';
}

export const AOV_TARGETS: readonly AovTarget[] = [
  { pass: 'lit', format: 'rgba8unorm', bpp: 4, encode: 'rgba8' }, // sRGB-encoded IN shader
  { pass: 'albedo', format: 'rgba8unorm', bpp: 4, encode: 'rgba8' }, // linear (data AOV)
  { pass: 'normal', format: 'rgba8unorm', bpp: 4, encode: 'rgba8' }, // n*0.5+0.5
  { pass: 'depth', format: 'r32float', bpp: 4, encode: 'gray16' }, // linearized view depth
  // coverage, NOT an object id: the FS writes a constant 1 wherever a fragment
  // survives, so 1 = drawn and 0 = empty IN THE TEXTURE. Multi-primitive
  // characters and socketed props are indistinguishable here; a real
  // per-primitive id would change these bytes and is a separate opt-in change.
  // The PNG carries the same boolean at full 16-bit scale (png.ts) so the file
  // is legible; readers test against 0, never against 1.
  { pass: 'mask', format: 'r32uint', bpp: 4, encode: 'u32' }, // 1 = drawn; 0 = empty
] as const;

// ---------------------------------------------------------------------------
// Host ⇄ WGSL layout interlock. Vertex buffers (one per attribute):
//   loc 0 POSITION   float32x3  stride 12
//   loc 1 NORMAL     float32x3  stride 12
//   loc 2 JOINTS_0   uint32x4   stride 16   (skinning.ts upconverts u8/u16 -> u32)
//   loc 3 WEIGHTS_0  float32x4  stride 16
//   loc 4 TEXCOORD_0 float32x2  stride 8    (zeros when a primitive has none)
// Bindings @group(0):
//   binding 0  uniform  Camera (160 B, see packCamera)
//   binding 1  storage  array<mat4x4<f32>>  (jointCount joint matrices)
// Bindings @group(1) — rebound per primitive range (renderer.ts draw loop):
//   binding 0  texture_2d<f32>  base color image (rgba8unorm-srgb, or
//                               rgba16float for a 1x1 white stand-in)
//   binding 1  sampler          linear, clamp-to-edge
//   binding 2  uniform Material 32 B: factor vec4 @0, cutoff f32 @16,
//                               mode f32 @20 (1 = MASK, 0 = OPAQUE)
// ---------------------------------------------------------------------------

/**
 * THE MATERIAL CONTRACT (implemented by skinning.ts + shaders.wgsl).
 *
 * 1. BASE COLOR IS A PRODUCT. glTF defines base color as
 *    `baseColorFactor * baseColorTexture`, and both halves must be honoured.
 *    Treating the factor as [1,1,1,1] whenever a texture exists — which this
 *    renderer did until the 2026-07-25 audit — renders a factor-tinted
 *    character at full brightness in lit AND albedo, and the adaptive palette
 *    is then built from those wrong colours.
 *
 * 2. THE FACTOR TRAVELS SEPARATELY FROM THE TEXTURE. It cannot be
 *    pre-multiplied into the decoded texels, because textures are deduped by
 *    glTF `Texture` identity and two materials may share one texture with
 *    different factors. So the unit of binding is the MATERIAL, not the
 *    texture.
 *
 * 3. ALPHA DECIDES THE SILHOUETTE, IN EVERY AOV. `alphaMode: 'MASK'` discards
 *    below `alphaCutoff`, so lit/albedo/normal/depth/mask agree by
 *    construction. A cutout that reached only the colour passes would leave
 *    the mask — and therefore the outline and the packed silhouette — claiming
 *    geometry that is not there.
 *
 * 4. BLEND IS TREATED AS A CUTOUT AT 0.5, deliberately, AND THE CUTOUT TESTS
 *    THE TEXTURE'S ALPHA ALONE. The AOV pass declares no blend state, and
 *    depth and mask are not blendable formats, so real alpha blending cannot be
 *    expressed without giving up the geometrically-identical-AOVs guarantee
 *    that makes one pass produce five consistent buffers. Sprite output is
 *    1-bit or soft alpha at the style stage regardless.
 *
 *    Dropping the factor's alpha for BLEND is not a shortcut: a uniform factor
 *    carries no SHAPE, so comparing it against a cutoff discards either every
 *    fragment or none. Keeping it made a cape at 40% opacity bake as NOTHING in
 *    all five AOVs (measured: 0 of 1024 mask texels) — absent, not hard-edged.
 *    A semi-transparent material bakes fully present and hard-edged; a texture
 *    with alpha holes still cuts out. MASK keeps the full glTF product, where
 *    factor.a below the cutoff really does mean the author declared the surface
 *    transparent.
 */
export const BLEND_AS_CUTOUT_AT = 0.5;
export const CAMERA_UNIFORM_FLOATS = 40; // 160 bytes: view(16) proj(16) params(4) lightDir(4)

/**
 * Pack the camera uniform exactly as the WGSL `Camera` struct expects:
 *   view: mat4 @0 · proj: mat4 @64 · params: vec4 @128 (x=near, y=far) ·
 *   lightDir: vec4 @144 (xyz = normalized world-space direction toward the
 *   light, w = the ambient floor)
 *
 * Ambient rides `lightDir.w` — a float that was already reserved and already
 * zero — rather than being a literal in the shader. Two copies of a lighting
 * constant is a constant that drifts, and the one in WGSL cannot be read by a
 * test that wants to predict what the shader will compute.
 */
export function packCamera(
  view: Float32Array,
  proj: Float32Array,
  near: number,
  far: number,
  lightDir: readonly [number, number, number],
  ambient: number,
): Float32Array {
  const d = new Float32Array(CAMERA_UNIFORM_FLOATS);
  d.set(view, 0);
  d.set(proj, 16);
  d[32] = near;
  d[33] = far;
  const l = Math.hypot(lightDir[0], lightDir[1], lightDir[2]) || 1;
  d[36] = lightDir[0] / l;
  d[37] = lightDir[1] / l;
  d[38] = lightDir[2] / l;
  d[39] = ambient;
  return d;
}
