import { resourcePath } from '@spritebook/core';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectPins } from '@spritebook/registry';
/**
 * The bake orchestrator (P2-T3): canonical glb -> styled, packed, manifested
 * bake dir, entirely via files across the D-004 seams (render seam -> pure
 * styleFromAovs -> pack). Emits the JobEvent vocabulary; no GPU object or pixel
 * buffer crosses this API.
 *
 * Cache model (cache.ts): every frame key embeds the full recipe. When a cache
 * dir is given the bake WRITES THROUGH always; it SERVES from cache only when
 * `onlyInvalidated` is set. The style stage is clip-atomic, so serving is
 * all-or-none: if any frame (or the style-result) misses, everything recomputes
 * — which is exactly what the recipe keys predict (predictInvalidation).
 *
 * Bake dir: <outRoot>/bake-<bakeId>/ per contracts.ts (manifest.json,
 * atlas_<pass>_<i>.png, style-result.json, contact-<clip>.gif).
 */
import { decode as decodePng } from 'fast-png';
import type {
  CacheKeyInputs,
  CameraPreset,
  ClipTiming,
  JobEvent,
  RenderPass,
  RigState,
  StylePreset,
} from '@spritebook/schema';
import { canonicalJson, RENDER_PASSES } from '@spritebook/schema';
import { sha256Bytes, sha256Hex, workspaceJob } from '@spritebook/core';
import {
  AMBIENT,
  DEFAULT_LIGHT_FRAME,
  LIGHT_DIR,
  renderSignature,
  runRenderJob,
} from '@spritebook/render';
import {
  type AovSource,
  type ClipAovSource,
  readAov,
  styleClipsFromAovs,
  styleFromAovs,
  type StyleResult,
} from '@spritebook/style';
import {
  type Clip,
  loadPack,
  loadPackClip,
  loadSkeletonRestFromFile,
  retargetClip,
  sampleClip,
  type SampledPoses,
  type SampleSpec,
  UAL_HUMANOID,
  writePoses,
  writePreviewGlb,
} from '@spritebook/anim';
import { posesFileName } from '@spritebook/anim';
import {
  atlasPageName,
  type CellPlane,
  DEFAULT_FPS,
  type FrameId,
  frameIdKey,
  PAGE_KIND,
} from './contracts.ts';
import { artifactKey, bakeKey, BlobCache, frameKey, rigForKey } from './cache.ts';
import { assembleManifest, frameGrid } from './manifest.ts';
import { assertRenderedPrefix, flipCellPng, type MirrorPlan, mirrorPlan } from './mirror.ts';
import { composePage, encodePagePng } from './atlas.ts';
import { packAnimationLayout } from './maxrects.ts';
import { aov1x } from './aov1x.ts';
import { buildContactSheet, contactThumbnail } from './contactsheet.ts';

export interface BakeJobSpec {
  jobId: string;
  workspace?: string;
  pinsPath?: string;
  /** immutable character id (slug) — binds the cache */
  characterId: string;
  /** canonical glb from the importer border */
  modelPath: string;
  /** 1x output framing (the bake supersamples internally per the style preset) */
  camera: CameraPreset;
  style: StylePreset;
  frames: number;
  /** the bake lands at <outRoot>/bake-<bakeId> */
  outRoot: string;
  /** enables the input-hash cache (write-through always when set) */
  cacheDir?: string;
  /** serve unchanged frames from the cache instead of recomputing */
  onlyInvalidated?: boolean;
  /**
   * P3-T1: real clips. Each binding retargets a pack clip onto the model
   * (once — D-006), samples it per the binding, renders pose 'clip'. Absent ->
   * the P2 idle-stub bake, byte-unchanged.
   */
  clips?: ClipBindingSpec[];
  /** pack directory holding clips/ (default: the bundled UAL pack) */
  packDir?: string;
  /**
   * D-008 mirroring, OFF by default and never inferred: only
   * `renderedDirections(N, true)` are styled, and the rest are horizontal flips
   * of their `mirrorSource` (mirror.ts). Changes the output, so it changes the
   * cache key (buildCacheInputs).
   */
  mirroring?: boolean;
  /** which frame the key light is fixed in (B3): omitted = the renderer's
   * default. Cache-covered via lightRigHash below. */
  lightFrame?: 'world' | 'camera';
  /**
   * The two recipe facts a glb cannot state: which rig this character is on and
   * which backend produced it. Present when the bake has a character to ask
   * (`bake --workspace`); absent for a bake of a bare file, which has neither.
   */
  provenance?: BakeProvenance;
}

export interface ClipBindingSpec extends SampleSpec {
  clipId: string;
}

/**
 * Where clip ids resolve when `spec.packDir` is absent.
 *
 * Exported because the CLI has to answer "which pack is this bake actually
 * reading?" before it trusts a manifest's clip bindings — a binding naming pack
 * "x" resolved against pack "y" renders a different animation under the same
 * clip id, and reports done.
 *
 * decodeURIComponent: URL.pathname percent-encodes (spaces, non-ASCII) — an
 * install under "C:\Users\First Last\..." must still resolve (review F3)
 */
export const BUNDLED_PACK = resourcePath('anim', 'packs/ual');

const CLIP_ID = 'idle';
const AOV_PASSES = ['albedo', 'normal', 'depth', 'mask'] as const;

/** Set to write `atlas_litraw_0.png` beside the shipped pages: the renderer's LIT
 * output BEFORE the style stage, on the same layout so the two atlases can be
 * diffed texel for texel.
 *
 * Opt-in, and deliberately not a manifest atlas — it is not a product output and
 * nothing downstream should learn to read it. It exists because the P3 exit
 * measurement found the shipped lit atlas nearly black with a correct albedo
 * underneath, and there was no way to tell a lighting bug from a palette bug
 * without re-rendering by hand. */
const DEBUG_RAW_LIT_ENV = 'SPRITEBOOK_DEBUG_RAW_LIT';

function debugRawLit(): boolean {
  return (process.env[DEBUG_RAW_LIT_ENV] ?? '') !== '';
}

/**
 * Where a bake's rig and backend facts come from when there IS a character to
 * ask. Absent means there is not one — see the sentinels in `buildCacheInputs`.
 */
export interface BakeProvenance {
  /** the character's RigState, hashed here rather than by the caller */
  rig?: RigState;
  /** the generation backend that produced the picked mesh, and its params */
  backend?: { modelId: string; version: string; params: Record<string, unknown> };
}

/**
 * The full bake recipe: model bytes + presets + clips + provenance.
 * `renderSig` is renderSignature() from @spritebook/render — pipeline version
 * composed with the adapter-identity hash (D-023), so the same recipe on a
 * different adapter is a different recipe (driver-version-only updates are a
 * known gap; see render/diagnostics.ts).
 *
 * `provenance` carries the two facts this function cannot read off a glb: which
 * rig the character is on, and which backend produced it. They arrive from the
 * manifest when a bake has one (`bake --workspace`), and are ABSENT for a bake
 * of a bare file, which genuinely has neither — see where the sentinels are
 * written for what absence is taken to mean.
 */
export async function buildCacheInputs(
  spec: Pick<
    BakeJobSpec,
    | 'characterId'
    | 'modelPath'
    | 'camera'
    | 'style'
    | 'frames'
    | 'clips'
    | 'packDir'
    | 'mirroring'
    | 'lightFrame'
  >,
  renderSig: string,
  provenance: BakeProvenance = {},
): Promise<CacheKeyInputs> {
  const modelBytes = new Uint8Array(await fs.readFile(spec.modelPath));
  // clip CONTENT is a cache input (invariant 3): the binding spec alone would
  // serve stale pixels after an in-place pack upgrade while the preview GLB
  // regenerates from the new bytes — a silent D-006 parity break (review F1).
  // Content-addressed, so the same clip bytes under a different packDir hit.
  let clipBindings: string;
  if (spec.clips?.length) {
    const packDir = spec.packDir ?? BUNDLED_PACK;
    const withContent = [];
    for (const c of spec.clips) {
      const clipPath = `${packDir}/clips/${c.clipId}.glb`;
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await fs.readFile(clipPath));
      } catch {
        throw new Error(`Cannot read clip "${c.clipId}" at "${clipPath}" - is the pack complete?`);
      }
      withContent.push({ ...c, clipSha256: await sha256Bytes(bytes) });
    }
    clipBindings = canonicalJson({ clips: withContent });
  } else {
    // legacy idle stub — hash input unchanged so P2-era caches stay valid
    clipBindings = canonicalJson({ clipId: CLIP_ID, frames: spec.frames, pose: 'idle' });
  }
  return {
    characterId: spec.characterId,
    canonicalMeshSha256: await sha256Bytes(modelBytes),
    // The character's rig when there is a character, and otherwise a sentinel
    // meaning NO RECORDED RIG — the skin is whatever this glb carries, keyed as
    // such. That is the honest answer for `bake --model x.glb`, which has no
    // manifest to ask; it used to be the answer for every bake, under a comment
    // saying the rig stage "lands with Track B", which it did in P3.
    //
    // `rigForKey` drops `accepted` (D-031): a human judgement that moves no
    // vertex must not invalidate a hundred bakes. The sentinel has no such
    // field, so an unrigged bake's key is byte-for-byte what it always was.
    rigStateHash: await sha256Hex(
      canonicalJson(provenance.rig ? rigForKey(provenance.rig) : { track: 'source-skin' }),
    ),
    clipBindingHash: await sha256Hex(clipBindings),
    // D-011, mirroring edition: mirroring changes the PIXELS (half the
    // directions become flips, and the adaptive palette pools over fewer
    // frames), so it must reach the key or a mirrored and an unmirrored bake
    // would trade cache entries. CacheKeyInputs is frozen and strict, so it
    // rides the field that already means "how directions are produced" — the
    // camera. The off path hashes the bare preset exactly as before, so every
    // pre-D-008 cache entry stays valid (same trick as the idle-stub binding).
    cameraPresetHash: await sha256Hex(
      spec.mirroring
        ? canonicalJson({ camera: spec.camera, mirroring: true })
        : canonicalJson(spec.camera),
    ),
    stylePresetHash: await sha256Hex(canonicalJson(spec.style)),
    // the rig as DATA, so a change to it invalidates by itself rather than by
    // whoever changed it also remembering to bump rendererVersion
    lightRigHash: await sha256Hex(canonicalJson({
      lightDir: spec.style.lighting?.direction ?? LIGHT_DIR,
      ambient: spec.style.lighting?.ambient ?? AMBIENT,
      lightFrame: spec.lightFrame ?? spec.style.lighting?.frame ?? DEFAULT_LIGHT_FRAME,
    })),
    rendererVersion: `${renderSig}|animation-atlas@1`,
    // The backend that made this character, when one did. `source-mesh@0` is
    // the sentinel for NOT GENERATED HERE — a mesh that came in through the
    // importer border — which is the truth for a bare-file bake and was a lie
    // for every other one: BakeManifest.inputs is a committed record, and "re-
    // run exactly this" cannot be honoured from a manifest that reports the
    // wrong backend for the model it baked.
    backend: {
      modelId: provenance.backend?.modelId ?? 'source-mesh',
      version: provenance.backend?.version ?? '0',
      paramsHash: await sha256Hex(canonicalJson(provenance.backend?.params ?? {})),
    },
  } as CacheKeyInputs;
}

/**
 * 1x pivot pixel for a preset — mirrors the render framing solver's convention
 * (packages/render/camera.ts: Math.round onto the texel lattice; feet-baseline
 * -> (w/2, h - paddingPx)). The integration test cross-checks this against a
 * real render-summary.json so the two implementations cannot drift silently.
 */
export function pivotFor(camera: CameraPreset): { x: number; y: number } {
  const { w, h } = camera.cellPx;
  if (camera.pivot === 'feet-baseline') {
    return { x: Math.round(w / 2), y: Math.round(h - camera.paddingPx) };
  }
  if (camera.pivot === 'center') return { x: Math.round(w / 2), y: Math.round(h / 2) };
  return {
    x: Math.round((camera.pivot.xPct / 100) * w),
    y: Math.round((camera.pivot.yPct / 100) * h),
  };
}

function supersample(camera: CameraPreset, s: number): CameraPreset {
  return {
    ...camera,
    pixelsPerMeter: camera.pixelsPerMeter * s,
    cellPx: { w: camera.cellPx.w * s, h: camera.cellPx.h * s },
    paddingPx: camera.paddingPx * s,
  };
}

/**
 * The persisted form of a StyleResult: `styledDir` is the live run's TEMP path —
 * an in-memory handle, meaningless once the cells are folded into atlas pages —
 * and a volatile absolute path has no place in a deterministic bake artifact
 * (caught by the byte-stability acceptance test).
 */
function persistedStyleResult(r: StyleResult): StyleResult {
  return { ...r, styledDir: '' };
}

interface BakedCells {
  /** frameIdKey -> encoded PNG bytes, per pass ('lit' = styled) */
  cells: Map<string, Map<string, Uint8Array>>;
  styleResult: StyleResult;
  /** frames served from cache (empty on a recompute) */
  hits: Set<string>;
  /** pre-style lit cells, only when SPRITEBOOK_DEBUG_RAW_LIT is set. Absent on
   * the cached path by design: the cache stores the STYLED lit, so a cache hit
   * has nothing pre-style to hand back and inventing one would be a lie. */
  rawLit?: Map<string, Uint8Array>;
}

/** Try to serve the ENTIRE bake from cache (all-or-none under clip-atomicity). */
async function tryCached(
  cache: BlobCache,
  bake: string,
  grid: FrameId[],
): Promise<BakedCells | null> {
  const styleBytes = await cache.get(await artifactKey(bake, 'style-result'));
  if (!styleBytes) return null;
  const cells = new Map<string, Map<string, Uint8Array>>(
    ['lit', ...AOV_PASSES].map((p) => [p, new Map<string, Uint8Array>()]),
  );
  for (const id of grid) {
    const fik = frameIdKey(id);
    const lit = await cache.get(await frameKey(bake, id));
    if (!lit) return null;
    cells.get('lit')!.set(fik, lit);
    for (const pass of AOV_PASSES) {
      const bytes = await cache.get(await artifactKey(bake, `aov-${pass}-${fik}`));
      if (!bytes) return null;
      cells.get(pass)!.set(fik, bytes);
    }
  }
  // a corrupt cache VALUE is a miss, mirroring the module's "invalid keys
  // throw, never miss" philosophy from the other side (adversarial review M2);
  // atomic puts should make this unreachable, but a miss self-heals and a
  // throw would poison every warm bake of the recipe
  try {
    const styleResult = JSON.parse(new TextDecoder().decode(styleBytes)) as StyleResult;
    return { cells, styleResult, hits: new Set(grid.map(frameIdKey)) };
  } catch {
    return null;
  }
}

interface PreparedClip {
  binding: ClipBindingSpec;
  sampled: SampledPoses;
  /** the clip's natural duration, kept so the manifest can report a real fps */
  durationS: number;
}

/**
 * Per-clip timing for the manifest. Every value comes from the binding or the
 * clip's own duration — both already inside `inputs.clipBindingHash` — so this
 * cannot drift from the cache key, and two bakes of one recipe stay identical.
 *
 * `fps` is the rate that replays the sampled window at the requested speed:
 * the bake covers `durationS / speed` seconds in `frames` samples, so
 * `fps = frames / (durationS / speed)`. `loop` is the inverse of `holdLast` —
 * holding the last frame is exactly what a non-looping clip does.
 */
function clipTimings(prepared: PreparedClip[]): ClipTiming[] {
  return prepared.map(({ binding, durationS }) => ({
    clipId: binding.clipId,
    frames: binding.frames,
    speed: binding.speed,
    holdLast: binding.holdLast,
    loop: !binding.holdLast,
    fps: binding.frames / (durationS / binding.speed),
  }));
}

/** Post-correction foot residual above this is worth a warn event (meters). */
const FOOT_WARN_M = 0.02;

/**
 * The anim stage — retarget ONCE per bake (D-006): load each pack clip, retarget
 * onto the model skeleton, sample per its binding, and emit the preview GLB
 * into the bake dir. Runs on BOTH the cached and recompute paths (CPU-cheap,
 * and previews must exist even when pixels come from cache).
 *
 * `warnings` carries the retarget evidence to the event stream (skill law:
 * unmapped joints are REPORTED, never guessed — a report nobody sees is a
 * guess with extra steps; review F2): core joints left at rest and foot
 * residuals above tolerance become `warn` JobEvents in runBakeJob.
 */
export async function prepareClips(
  spec: BakeJobSpec,
  bakeDir: string,
): Promise<{ prepared: PreparedClip[]; warnings: { code: string; message: string }[] }> {
  const packDir = spec.packDir ?? BUNDLED_PACK;
  const targetRest = await loadSkeletonRestFromFile(spec.modelPath);
  const prepared: PreparedClip[] = [];
  const warnings: { code: string; message: string }[] = [];
  for (const binding of spec.clips!) {
    const source: Clip = await loadPackClip(packDir, binding.clipId);
    // the pack clip glb carries its own skeleton rest — load it per clip file
    const sourceRest = await loadSkeletonRestFromFile(
      `${packDir}/clips/${binding.clipId}.glb`,
    );
    const { clip, report, stats } = retargetClip(source, sourceRest, targetRest, UAL_HUMANOID);
    // canonical-space comparison: an aliased target joint (D-040) is driven
    // even though its own name is not the profile's
    const coreMissing = UAL_HUMANOID.core.filter(
      (c) => !report.mapped.some((m) => (report.aliases?.[m] ?? m) === c),
    );
    if (coreMissing.length) {
      warnings.push({
        code: 'anim-unmapped-core',
        message: `clip "${binding.clipId}": ${coreMissing.length} core joints not driven ` +
          `(${coreMissing.join(', ')}) - they hold the rest pose`,
      });
    }
    if (stats.footContactMaxErrM > FOOT_WARN_M) {
      warnings.push({
        code: 'anim-foot-contact',
        message: `clip "${binding.clipId}": feet off ground by up to ` +
          `${(stats.footContactMaxErrM * 100).toFixed(1)}cm on contact frames ` +
          `(tolerance ${FOOT_WARN_M * 100}cm)`,
      });
    }
    await writePreviewGlb(spec.modelPath, clip, `${bakeDir}/preview-${binding.clipId}.glb`);
    prepared.push({
      binding,
      sampled: sampleClip(clip, targetRest, binding),
      durationS: clip.duration,
    });
  }
  return { prepared, warnings };
}

/**
 * Produce the mirrored cells (D-008): every pass of a mirrored direction is the
 * horizontal flip of the SAME frame of its `mirrorSource` direction, so the
 * mirrored cells enter the packer indistinguishable from rendered ones and the
 * atlas layout keeps its shape.
 */
function fillMirroredCells(
  cells: Map<string, Map<string, Uint8Array>>,
  grid: FrameId[],
  plan: MirrorPlan,
): void {
  for (const id of grid) {
    const source = plan.mirroredFrom.get(id.direction);
    if (source === undefined) continue;
    const from = frameIdKey({ ...id, direction: source });
    const to = frameIdKey(id);
    for (const [pass, byKey] of cells) {
      const bytes = byKey.get(from);
      if (!bytes) {
        throw new Error(
          `mirroring: direction ${id.direction} mirrors ${source}, but no ${pass} cell ` +
            `exists for "${from}" - the rendered set and the mirror map disagree`,
        );
      }
      byKey.set(to, flipCellPng(bytes, pass as RenderPass));
    }
  }
}

/** Full multi-clip recompute: per clip render pose 'clip' -> pooled style -> cells. */
async function recomputeClips(
  spec: BakeJobSpec,
  prepared: PreparedClip[],
  grid: FrameId[],
  plan: MirrorPlan,
): Promise<BakedCells & { aovDirCleanup: () => Promise<void> }> {
  const s = spec.style.temporal.superSample;
  const aovRoot = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  const cleanup = async () => {
    await fs.rm(aovRoot, { recursive: true }).catch(() => {});
  };

  try {
    const srcs: ClipAovSource[] = [];
    for (const { binding, sampled } of prepared) {
      const clipDir = `${aovRoot}/${binding.clipId}`;
      await fs.mkdir(clipDir, { recursive: true });
      const posesPath = `${clipDir}/${posesFileName(binding.clipId)}`;
      await writePoses(posesPath, binding.clipId, sampled);
      for await (
        const e of runRenderJob({
          jobId: `${spec.jobId}-render-${binding.clipId}`,
          modelPath: spec.modelPath,
          camera: supersample(spec.camera, s),
          frames: binding.frames,
          lightFrame: spec.lightFrame,
          lighting: spec.style.lighting,
          pose: 'clip',
          posesPath,
          // D-008: only the directions that are not flips (mirror.ts) — the
          // saving has to be taken at the GPU or it is not a saving
          directionSubset: plan.rendered,
          stylePreset: spec.style.id,
          outDir: clipDir,
        })
      ) {
        if (e.t === 'error') {
          throw Object.assign(new Error(`render ${binding.clipId} failed: ${e.message}`), {
            code: e.code,
            retryable: e.retryable,
          });
        }
      }
      srcs.push({
        clipId: binding.clipId,
        framesDir: `${clipDir}/frames`,
        // D-008: style only the directions the mirror rule says must be styled.
        // The rendered set is the prefix [0..n-1] (assertRenderedPrefix), which
        // is exactly the positional naming the style stage reads, so the extra
        // dDD_* pages the render seam had to produce are simply never opened.
        directions: plan.rendered.length,
        frames: binding.frames,
        width: spec.camera.cellPx.w * s,
        height: spec.camera.cellPx.h * s,
      });
    }

    const styleOut = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
    try {
      const styleResult = await styleClipsFromAovs(srcs, spec.camera, spec.style, styleOut);
      const cells = new Map<string, Map<string, Uint8Array>>(
        ['lit', ...AOV_PASSES].map((p) => [p, new Map<string, Uint8Array>()]),
      );
      const rawLit = debugRawLit() ? new Map<string, Uint8Array>() : undefined;
      for (const id of grid) {
        if (plan.mirroredFrom.has(id.direction)) continue; // flipped below
        const fik = frameIdKey(id);
        const d = String(id.direction).padStart(2, '0');
        const f = String(id.frame).padStart(3, '0');
        cells.get('lit')!.set(
          fik,
          new Uint8Array(
            await fs.readFile(`${styleResult.styledDir}/${id.clipId}/d${d}_f${f}.png`),
          ),
        );
        const src = srcs.find((x) => x.clipId === id.clipId)!;
        const aov = await readAov(src.framesDir, id.direction, id.frame);
        const one = aov1x(aov, s);
        cells.get('albedo')!.set(fik, encodePagePng(one.albedo, 'rgba8'));
        rawLit?.set(fik, encodePagePng(one.lit, 'rgba8'));
        cells.get('normal')!.set(fik, encodePagePng(one.normal, 'rgba8'));
        cells.get('depth')!.set(fik, encodePagePng(one.depth, 'gray16'));
        cells.get('mask')!.set(fik, encodePagePng(one.mask, 'gray16'));
      }
      fillMirroredCells(cells, grid, plan);
      return { cells, rawLit, styleResult, hits: new Set<string>(), aovDirCleanup: cleanup };
    } finally {
      await fs.rm(styleOut, { recursive: true }).catch(() => {});
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** Full recompute: render Sx AOVs -> style -> 1x AOV cells. */
async function recompute(
  spec: BakeJobSpec,
  grid: FrameId[],
  plan: MirrorPlan,
): Promise<BakedCells & { aovDirCleanup: () => Promise<void> }> {
  const s = spec.style.temporal.superSample;
  const aovDir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  const cleanup = async () => {
    await fs.rm(aovDir, { recursive: true }).catch(() => {});
  };

  for await (
    const e of runRenderJob({
      jobId: `${spec.jobId}-render`,
      modelPath: spec.modelPath,
      camera: supersample(spec.camera, s),
      frames: spec.frames,
      lightFrame: spec.lightFrame,
      lighting: spec.style.lighting,
      pose: 'idle',
      // D-008: only the non-flip directions (mirror.ts)
      directionSubset: plan.rendered,
      stylePreset: spec.style.id,
      outDir: aovDir,
    })
  ) {
    if (e.t === 'error') {
      await cleanup();
      throw Object.assign(new Error(`render failed [${e.code}]: ${e.message}`), {
        code: e.code,
        retryable: e.retryable,
      });
    }
  }

  const src: AovSource = {
    framesDir: `${aovDir}/frames`,
    // D-008: style only the rendered directions (see recomputeClips)
    directions: plan.rendered.length,
    frames: spec.frames,
    width: spec.camera.cellPx.w * s,
    height: spec.camera.cellPx.h * s,
  };
  // from here on, any throw must not leak the temp dirs (adversarial review m6)
  const styleOut = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const styleResult = await styleFromAovs(src, spec.camera, spec.style, styleOut);

    const cells = new Map<string, Map<string, Uint8Array>>(
      ['lit', ...AOV_PASSES].map((p) => [p, new Map<string, Uint8Array>()]),
    );
    const rawLit = debugRawLit() ? new Map<string, Uint8Array>() : undefined;
    for (const id of grid) {
      if (plan.mirroredFrom.has(id.direction)) continue; // flipped below
      const fik = frameIdKey(id);
      const d = String(id.direction).padStart(2, '0');
      const f = String(id.frame).padStart(3, '0');
      cells.get('lit')!.set(
        fik,
        new Uint8Array(await fs.readFile(`${styleResult.styledDir}/d${d}_f${f}.png`)),
      );
      const aov = await readAov(src.framesDir, id.direction, id.frame);
      const one = aov1x(aov, s);
      cells.get('albedo')!.set(fik, encodePagePng(one.albedo, 'rgba8'));
      rawLit?.set(fik, encodePagePng(one.lit, 'rgba8'));
      cells.get('normal')!.set(fik, encodePagePng(one.normal, 'rgba8'));
      cells.get('depth')!.set(fik, encodePagePng(one.depth, 'gray16'));
      cells.get('mask')!.set(fik, encodePagePng(one.mask, 'gray16'));
    }
    fillMirroredCells(cells, grid, plan);
    return { cells, rawLit, styleResult, hits: new Set<string>(), aovDirCleanup: cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  } finally {
    await fs.rm(styleOut, { recursive: true }).catch(() => {});
  }
}

function decodeCell(bytes: Uint8Array, kind: 'rgba8' | 'gray16'): CellPlane {
  const img = decodePng(bytes);
  return kind === 'rgba8'
    ? { w: img.width, h: img.height, rgba: img.data as Uint8Array }
    : { w: img.width, h: img.height, gray16: img.data as Uint16Array };
}

/** Bake one character: render -> style -> pack -> manifest, files + events only. */
async function* executeBakeJob(spec: BakeJobSpec): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = spec.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  // hoisted so the catch can release the recompute temp dir on ANY failure (m6)
  let cleanup: (() => Promise<void>) | undefined;
  try {
    await projectPins(spec);
    if (spec.clips?.length) await loadPack(spec.packDir ?? BUNDLED_PACK, spec);
    // model existence first (the friendlier error on every machine), THEN the
    // adapter-bound render signature — baking is a GPU operation either way
    try {
      await fs.stat(spec.modelPath);
    } catch {
      throw new Error(`Cannot read "${spec.modelPath}" - does the file exist?`);
    }
    // one binding per clip: three downstream paths key on clipId alone (poses
    // dir, styled dir, preview glb) — a duplicate would fail late after full
    // GPU work with an unactionable message (review F4)
    if (spec.clips) {
      const seen = new Set<string>();
      for (const c of spec.clips) {
        if (seen.has(c.clipId)) {
          throw new Error(`duplicate clip binding "${c.clipId}" - one binding per clip`);
        }
        seen.add(c.clipId);
      }
    }
    const inputs = await buildCacheInputs(spec, await renderSignature(), spec.provenance);
    const bake = await bakeKey(inputs);
    const bakeDir = `${spec.outRoot}/bake-${bake.slice(0, 8)}`;
    await fs.mkdir(bakeDir, { recursive: true });
    const grid = spec.clips?.length
      ? spec.clips.flatMap((c) => frameGrid(spec.camera.directions, c.frames, c.clipId))
      : frameGrid(spec.camera.directions, spec.frames, CLIP_ID);
    const cache = spec.cacheDir ? new BlobCache(spec.cacheDir) : null;
    // D-008: the frozen rule (schema/roster.ts), turned into this bake's plan
    const plan = mirrorPlan(spec.camera.directions, spec.mirroring === true);
    assertRenderedPrefix(plan);
    if (plan.mirroredFrom.size > 0) {
      // the saving is real at every stage: the render seam takes
      // `directionSubset` so the GPU draws only the non-flip directions, and
      // style/downsample/cache-write skip the rest too
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'mirroring-on',
        message: `mirroring is on: ${plan.rendered.length} of ${spec.camera.directions} ` +
          `directions are rendered and ${plan.mirroredFrom.size} are horizontal flips. ` +
          `Turn it off for any character whose left and right differ.`,
      };
    }

    // 0. the anim stage (clips only): retarget ONCE, emit previews — runs on
    // the cached path too (previews are bake artifacts, pixels or not)
    const anim = spec.clips?.length ? await prepareClips(spec, bakeDir) : null;
    const prepared = anim?.prepared ?? null;
    for (const w of anim?.warnings ?? []) {
      yield { t: 'warn', jobId, at: at(), code: w.code, message: w.message };
    }

    // 1. cells: cached (all-or-none) or full recompute
    yield { t: 'progress', jobId, at: at(), step: 'cells', done: 1, total: 4 };
    let baked: BakedCells | null = null;
    if (cache && spec.onlyInvalidated) baked = await tryCached(cache, bake, grid);
    if (!baked) {
      const r = prepared
        ? await recomputeClips(spec, prepared, grid, plan)
        : await recompute(spec, grid, plan);
      baked = r;
      cleanup = r.aovDirCleanup;
    }

    // write-through (always, when a cache dir is configured)
    if (cache) {
      for (const id of grid) {
        const fik = frameIdKey(id);
        await cache.put(await frameKey(bake, id), baked.cells.get('lit')!.get(fik)!);
        for (const pass of AOV_PASSES) {
          await cache.put(
            await artifactKey(bake, `aov-${pass}-${fik}`),
            baked.cells.get(pass)!.get(fik)!,
          );
        }
      }
      await cache.put(
        await artifactKey(bake, 'style-result'),
        new TextEncoder().encode(JSON.stringify(persistedStyleResult(baked.styleResult))),
      );
    }

    // 2. pack: ONE layout from the lit cells, replayed on every AOV page (law)
    yield { t: 'progress', jobId, at: at(), step: 'pack', done: 2, total: 4 };
    const rgbaCells = new Map<string, Uint8Array>();
    let contactW = spec.camera.cellPx.w, contactH = spec.camera.cellPx.h;
    // THE LAW, by construction: one layout, computed once from the lit cells,
    // replayed verbatim on all five passes below. The runtime guard against a
    // pass diverging is composePage's cell-size-mismatch throw (an AOV cell
    // that disagrees with its lit rect refuses to composite); asserting rect
    // identity on five references to this one object would be theater (m5) —
    // assertRectIdentity remains for callers holding genuinely separate layouts.
    const layout = packAnimationLayout(
      grid.map((id) => {
        return { id, w: spec.camera.cellPx.w, h: spec.camera.cellPx.h };
      }),
      {
        maxPageSizePx: Math.max(
          2048,
          2 ** Math.ceil(Math.log2(Math.max(spec.camera.cellPx.w, spec.camera.cellPx.h))),
        ),
      },
    );

    for (const pass of RENDER_PASSES) {
      const kind = PAGE_KIND[pass];
      for (let i = 0; i < layout.pageCount; i++) {
        const source = new Map<string, CellPlane>();
        for (const rect of layout.rects) {
          if (rect.pageIndex !== i) continue;
          const key = frameIdKey(rect.id),
            cell = decodeCell(baked.cells.get(pass)!.get(key)!, kind);
          source.set(key, cell);
          if (pass === 'lit') {
            const thumb = contactThumbnail(cell.rgba!, cell.w, cell.h);
            rgbaCells.set(key, thumb.rgba);
            contactW = thumb.w;
            contactH = thumb.h;
          }
        }
        const page = composePage(layout, i, source, kind);
        await fs.writeFile(`${bakeDir}/${atlasPageName(pass, i)}`, encodePagePng(page, kind));
      }
    }

    // the debug page, on the SAME layout so it diffs texel-for-texel against
    // atlas_lit_*. Not in the manifest: nothing downstream should read it.
    if (baked.rawLit) {
      const raw = new Map(
        [...baked.rawLit].map(([k, bytes]) => [k, decodeCell(bytes, 'rgba8')]),
      );
      for (let i = 0; i < layout.pageCount; i++) {
        await fs.writeFile(
          `${bakeDir}/atlas_litraw_${i}.png`,
          encodePagePng(composePage(layout, i, raw, 'rgba8'), 'rgba8'),
        );
      }
    }

    // 3. artifacts: style-result, contact sheet, manifest
    yield { t: 'progress', jobId, at: at(), step: 'write', done: 3, total: 4 };
    await fs.writeFile(
      `${bakeDir}/style-result.json`,
      JSON.stringify(persistedStyleResult(baked.styleResult), null, 2) + '\n',
    );
    const clipList = spec.clips?.length
      ? spec.clips.map((c) => ({ clipId: c.clipId, frames: c.frames }))
      : [{ clipId: CLIP_ID, frames: spec.frames }];
    for (const c of clipList) {
      const gif = buildContactSheet(rgbaCells, {
        clipId: c.clipId,
        directions: spec.camera.directions,
        frames: c.frames,
        cellW: contactW,
        cellH: contactH,
        fps: DEFAULT_FPS,
      });
      await fs.writeFile(`${bakeDir}/contact-${c.clipId}.gif`, gif);
    }

    const manifest = await assembleManifest({
      inputs,
      layout,
      pivotPx: pivotFor(spec.camera),
      cacheHits: baked.hits,
      mirroredFrom: plan.mirroredFrom,
      styleResult: { flickerPct: baked.styleResult.flickerPct, flags: baked.styleResult.flags },
      ...(prepared ? { clips: clipTimings(prepared) } : {}),
      wallTimeS: (performance.now() - t0) / 1000,
      now: at,
    });
    await fs.writeFile(`${bakeDir}/manifest.json`, canonicalJson(manifest));
    await cleanup?.();

    yield { t: 'progress', jobId, at: at(), step: 'manifest', done: 4, total: 4 };
    yield {
      t: 'artifact',
      jobId,
      at: at(),
      kind: 'bake-manifest',
      path: `${bakeDir}/manifest.json`,
    };
    yield { t: 'artifact', jobId, at: at(), kind: 'bake-dir', path: bakeDir };
    for (const flag of manifest.flags) {
      yield { t: 'warn', jobId, at: at(), code: flag.code, message: flag.message };
    }
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - t0) / 1000 };
  } catch (err) {
    await cleanup?.().catch(() => {});
    const code = (err as { code?: unknown })?.code;
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: typeof code === 'string' ? code : 'bake-failed',
      message: err instanceof Error ? err.message : String(err),
      retryable: (err as { retryable?: unknown })?.retryable === true,
    };
  }
}

export function runBakeJob(spec: BakeJobSpec): AsyncIterable<JobEvent> {
  return workspaceJob(spec.workspace, () => executeBakeJob(spec));
}
