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
import type { CacheKeyInputs, CameraPreset, JobEvent, StylePreset } from '@spritebook/schema';
import { canonicalJson, RENDER_PASSES } from '@spritebook/schema';
import { sha256Hex } from '@spritebook/core';
import { renderSignature, runRenderJob } from '@spritebook/render';
import { type AovSource, readAov, styleFromAovs, type StyleResult } from '@spritebook/style';
import {
  atlasPageName,
  type CellPlane,
  DEFAULT_FPS,
  type FrameId,
  frameIdKey,
  PAGE_KIND,
} from './contracts.ts';
import { artifactKey, bakeKey, BlobCache, frameKey } from './cache.ts';
import { assembleManifest, frameGrid } from './manifest.ts';
import { composePage, encodePagePng } from './atlas.ts';
import { packLayout } from './maxrects.ts';
import { aov1x } from './aov1x.ts';
import { buildContactSheet } from './contactsheet.ts';

export interface BakeJobSpec {
  jobId: string;
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
}

const CLIP_ID = 'idle';
const AOV_PASSES = ['albedo', 'normal', 'depth', 'mask'] as const;

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The full bake recipe: model bytes + presets + the idle clip stub + sentinels.
 * `renderSig` is renderSignature() from @spritebook/render — pipeline version
 * composed with the adapter-identity hash (D-023), so the same recipe on a
 * different adapter is a different recipe (driver-version-only updates are a
 * known gap; see render/diagnostics.ts).
 */
export async function buildCacheInputs(
  spec: Pick<BakeJobSpec, 'characterId' | 'modelPath' | 'camera' | 'style' | 'frames'>,
  renderSig: string,
): Promise<CacheKeyInputs> {
  const modelBytes = await Deno.readFile(spec.modelPath);
  return {
    characterId: spec.characterId,
    canonicalMeshSha256: await sha256OfBytes(modelBytes),
    // pre-rig sentinel: the rig stage lands with Track B (P3); until then the
    // skin is whatever the canonical glb carries, keyed as such
    rigStateHash: await sha256Hex(canonicalJson({ track: 'source-skin' })),
    clipBindingHash: await sha256Hex(
      canonicalJson({ clipId: CLIP_ID, frames: spec.frames, pose: 'idle' }),
    ),
    cameraPresetHash: await sha256Hex(canonicalJson(spec.camera)),
    stylePresetHash: await sha256Hex(canonicalJson(spec.style)),
    rendererVersion: renderSig,
    // no generation backend in the T3 path: the mesh comes in from the border
    backend: {
      modelId: 'source-mesh',
      version: '0',
      paramsHash: await sha256Hex(canonicalJson({})),
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

/** Full recompute: render Sx AOVs -> style -> 1x AOV cells. */
async function recompute(
  spec: BakeJobSpec,
  grid: FrameId[],
): Promise<BakedCells & { aovDirCleanup: () => Promise<void> }> {
  const s = spec.style.temporal.superSample;
  const aovDir = await Deno.makeTempDir();
  const cleanup = async () => {
    await Deno.remove(aovDir, { recursive: true }).catch(() => {});
  };

  for await (
    const e of runRenderJob({
      jobId: `${spec.jobId}-render`,
      modelPath: spec.modelPath,
      camera: supersample(spec.camera, s),
      frames: spec.frames,
      pose: 'idle',
      stylePreset: spec.style.id,
      outDir: aovDir,
    })
  ) {
    if (e.t === 'error') {
      await cleanup();
      throw new Error(`render failed [${e.code}]: ${e.message}`);
    }
  }

  const src: AovSource = {
    framesDir: `${aovDir}/frames`,
    directions: spec.camera.directions,
    frames: spec.frames,
    width: spec.camera.cellPx.w * s,
    height: spec.camera.cellPx.h * s,
  };
  // from here on, any throw must not leak the temp dirs (adversarial review m6)
  const styleOut = await Deno.makeTempDir();
  try {
    const styleResult = await styleFromAovs(src, spec.camera, spec.style, styleOut);

    const cells = new Map<string, Map<string, Uint8Array>>(
      ['lit', ...AOV_PASSES].map((p) => [p, new Map<string, Uint8Array>()]),
    );
    for (const id of grid) {
      const fik = frameIdKey(id);
      const d = String(id.direction).padStart(2, '0');
      const f = String(id.frame).padStart(3, '0');
      cells.get('lit')!.set(fik, await Deno.readFile(`${styleResult.styledDir}/d${d}_f${f}.png`));
      const aov = await readAov(src.framesDir, id.direction, id.frame);
      const one = aov1x(aov, s);
      cells.get('albedo')!.set(fik, encodePagePng(one.albedo, 'rgba8'));
      cells.get('normal')!.set(fik, encodePagePng(one.normal, 'rgba8'));
      cells.get('depth')!.set(fik, encodePagePng(one.depth, 'gray16'));
      cells.get('mask')!.set(fik, encodePagePng(one.mask, 'gray16'));
    }
    return { cells, styleResult, hits: new Set<string>(), aovDirCleanup: cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  } finally {
    await Deno.remove(styleOut, { recursive: true }).catch(() => {});
  }
}

function decodeCell(bytes: Uint8Array, kind: 'rgba8' | 'gray16'): CellPlane {
  const img = decodePng(bytes);
  return kind === 'rgba8'
    ? { w: img.width, h: img.height, rgba: img.data as Uint8Array }
    : { w: img.width, h: img.height, gray16: img.data as Uint16Array };
}

/** Bake one character: render -> style -> pack -> manifest, files + events only. */
export async function* runBakeJob(spec: BakeJobSpec): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = spec.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  // hoisted so the catch can release the recompute temp dir on ANY failure (m6)
  let cleanup: (() => Promise<void>) | undefined;
  try {
    // model existence first (the friendlier error on every machine), THEN the
    // adapter-bound render signature — baking is a GPU operation either way
    try {
      await Deno.stat(spec.modelPath);
    } catch {
      throw new Error(`Cannot read "${spec.modelPath}" - does the file exist?`);
    }
    const inputs = await buildCacheInputs(spec, await renderSignature());
    const bake = await bakeKey(inputs);
    const bakeDir = `${spec.outRoot}/bake-${bake.slice(0, 8)}`;
    await Deno.mkdir(bakeDir, { recursive: true });
    const grid = frameGrid(spec.camera.directions, spec.frames, CLIP_ID);
    const cache = spec.cacheDir ? new BlobCache(spec.cacheDir) : null;

    // 1. cells: cached (all-or-none) or full recompute
    yield { t: 'progress', jobId, at: at(), step: 'cells', done: 1, total: 4 };
    let baked: BakedCells | null = null;
    if (cache && spec.onlyInvalidated) baked = await tryCached(cache, bake, grid);
    if (!baked) {
      const r = await recompute(spec, grid);
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
    const decoded = new Map<string, Map<string, CellPlane>>();
    for (const pass of ['lit', ...AOV_PASSES]) {
      const kind = PAGE_KIND[pass as keyof typeof PAGE_KIND];
      decoded.set(
        pass,
        new Map(
          [...baked.cells.get(pass)!].map(([k, bytes]) => [k, decodeCell(bytes, kind)]),
        ),
      );
    }
    const litCells = decoded.get('lit')!;
    // THE LAW, by construction: one layout, computed once from the lit cells,
    // replayed verbatim on all five passes below. The runtime guard against a
    // pass diverging is composePage's cell-size-mismatch throw (an AOV cell
    // that disagrees with its lit rect refuses to composite); asserting rect
    // identity on five references to this one object would be theater (m5) —
    // assertRectIdentity remains for callers holding genuinely separate layouts.
    const layout = packLayout(
      grid.map((id) => {
        const c = litCells.get(frameIdKey(id))!;
        return { id, w: c.w, h: c.h };
      }),
    );

    for (const pass of RENDER_PASSES) {
      const kind = PAGE_KIND[pass];
      const source = pass === 'lit' ? litCells : decoded.get(pass)!;
      for (let i = 0; i < layout.pageCount; i++) {
        const page = composePage(layout, i, source, kind);
        await Deno.writeFile(`${bakeDir}/${atlasPageName(pass, i)}`, encodePagePng(page, kind));
      }
    }

    // 3. artifacts: style-result, contact sheet, manifest
    yield { t: 'progress', jobId, at: at(), step: 'write', done: 3, total: 4 };
    await Deno.writeTextFile(
      `${bakeDir}/style-result.json`,
      JSON.stringify(persistedStyleResult(baked.styleResult), null, 2) + '\n',
    );
    const gif = buildContactSheet(
      new Map([...litCells].map(([k, c]) => [k, c.rgba!])),
      {
        clipId: CLIP_ID,
        directions: spec.camera.directions,
        frames: spec.frames,
        cellW: spec.camera.cellPx.w,
        cellH: spec.camera.cellPx.h,
        fps: DEFAULT_FPS,
      },
    );
    await Deno.writeFile(`${bakeDir}/contact-${CLIP_ID}.gif`, gif);

    const manifest = await assembleManifest({
      inputs,
      layout,
      pivotPx: pivotFor(spec.camera),
      cacheHits: baked.hits,
      styleResult: { flickerPct: baked.styleResult.flickerPct, flags: baked.styleResult.flags },
      wallTimeS: (performance.now() - t0) / 1000,
      now: at,
    });
    await Deno.writeTextFile(`${bakeDir}/manifest.json`, canonicalJson(manifest));
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
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: 'bake-failed',
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    };
  }
}
