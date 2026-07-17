/**
 * BakeManifest assembly (D-010: the manifest is canonical; exporters are pure
 * projections of it). bakeId is the first 8 hex of the bake-level cache key, so
 * an unchanged rebake gets the SAME bakeId and bake dir — identity follows the
 * recipe, not the clock. The style stage's result folds in as metrics.flickerPct
 * + flags (the palette itself ships as style-result.json in the bake dir — the
 * schema has no palette field by design; see progress notes).
 */
import type { BakeManifest, CacheKeyInputs, QAFlag, RenderPass } from '@spritebook/schema';
import { BakeManifestSchema, parseWith, RENDER_PASSES, SCHEMA_VERSION } from '@spritebook/schema';
import { atlasPageName, type FrameId, frameIdKey, type PackLayout } from './contracts.ts';
import { bakeKey } from './cache.ts';

export interface AssembleArgs {
  inputs: CacheKeyInputs;
  layout: PackLayout;
  /** per-frame pivot (identical across directions under world-locked framing) */
  pivotPx: { x: number; y: number };
  /** frame ids that were served from cache (all-or-none under clip-atomic style) */
  cacheHits: Set<string>;
  styleResult: { flickerPct: number; flags: QAFlag[] };
  wallTimeS: number;
  now: () => string;
}

/** Assemble + schema-validate the BakeManifest from a completed pack. */
export async function assembleManifest(args: AssembleArgs): Promise<BakeManifest> {
  const key = await bakeKey(args.inputs);
  const framesTotal = args.layout.rects.length;
  let hits = 0;

  const frames = args.layout.rects.map((r) => {
    const hit = args.cacheHits.has(frameIdKey(r.id));
    if (hit) hits++;
    return {
      clipId: r.id.clipId,
      direction: r.id.direction,
      frame: r.id.frame,
      pivotPx: args.pivotPx,
      atlas: { pageIndex: r.pageIndex, x: r.x, y: r.y, w: r.w, h: r.h },
      cacheHit: hit,
    };
  });

  const atlases = [];
  for (const pass of RENDER_PASSES as readonly RenderPass[]) {
    for (let i = 0; i < args.layout.pageCount; i++) {
      atlases.push({
        pageIndex: i,
        pass,
        sizePx: args.layout.pageSizePx,
        png: atlasPageName(pass, i),
        layoutSharedWith: 'lit' as const,
      });
    }
  }

  return parseWith(BakeManifestSchema, {
    schemaVersion: SCHEMA_VERSION,
    bakeId: key.slice(0, 8),
    characterId: args.inputs.characterId,
    inputs: args.inputs,
    frames,
    atlases,
    metrics: {
      flickerPct: args.styleResult.flickerPct,
      cacheHitPct: framesTotal === 0 ? 0 : (hits / framesTotal) * 100,
      wallTimeS: args.wallTimeS,
      framesTotal,
    },
    flags: args.styleResult.flags,
    createdAt: args.now(),
  }, 'BakeManifest');
}

/** Deterministic full frame-id grid for the T3 idle clip. */
export function frameGrid(directions: number, frames: number, clipId = 'idle'): FrameId[] {
  const out: FrameId[] = [];
  for (let d = 0; d < directions; d++) {
    for (let f = 0; f < frames; f++) out.push({ clipId, direction: d, frame: f });
  }
  return out;
}
