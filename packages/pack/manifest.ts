/**
 * BakeManifest assembly (D-010: the manifest is canonical; exporters are pure
 * projections of it). bakeId is the first 8 hex of the bake-level cache key, so
 * an unchanged rebake gets the SAME bakeId and bake dir — identity follows the
 * recipe, not the clock. The style stage's result folds in as metrics.flickerPct
 * + flags (the palette itself ships as style-result.json in the bake dir — the
 * schema has no palette field by design; see progress notes).
 */
import type {
  BakeManifest,
  CacheKeyInputs,
  ClipTiming,
  QAFlag,
  RenderPass,
} from '@spritebook/schema';
import { BakeManifestSchema, parseWith, RENDER_PASSES, SCHEMA_VERSION } from '@spritebook/schema';
import { atlasPageName, type FrameId, frameIdKey, type PackLayout } from './contracts.ts';
import { bakeKey } from './cache.ts';

export interface AssembleArgs {
  inputs: CacheKeyInputs;
  layout: PackLayout;
  /**
   * The pivot the RENDERED cells were framed with. World-locked framing makes
   * it identical across every rendered direction — but a D-008 mirrored cell is
   * a horizontal flip, so its own pivot flips too and the recorded value is
   * `w - x` (see the frame loop below). Pre-D-008 this was invariant per bake.
   */
  pivotPx: { x: number; y: number };
  /** frame ids that were served from cache (all-or-none under clip-atomic style) */
  cacheHits: Set<string>;
  /**
   * D-008: mirrored direction -> the direction its pixels were flipped from.
   * Recorded per frame so a consumer can tell a mirrored sprite from a rendered
   * one — which matters the moment anyone asks why a decal changed arms. Empty
   * (or absent) when mirroring is off, and then no frame carries the field.
   */
  mirroredFrom?: Map<number, number>;
  styleResult: { flickerPct: number; flags: QAFlag[] };
  /**
   * Per-clip timing for exporters (schema/bake.ts ClipTiming). Absent for a
   * legacy idle bake, which keeps its manifest byte-identical to a pre-clip one.
   */
  clips?: ClipTiming[];
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
    // the schema keeps `mirroredFrom` optional and absent when mirroring is
    // off, so an unmirrored manifest is byte-identical to a pre-D-008 one
    const source = args.mirroredFrom?.get(r.id.direction);
    // A mirrored cell is the horizontal flip of its source, so the pivot flips
    // with the pixels or every mirrored sprite hangs off the wrong anchor —
    // and nothing downstream can tell, because export/strips.ts and
    // export/texturepacker.ts project this field verbatim and neither knows
    // mirroring exists. `w - x`, NOT `w - 1 - x`: pivotPx is an EDGE coordinate
    // on the continuous range [0, w] (render/camera.ts:9-12 states the
    // convention; camera.ts inverts it as pivotPx.x = w*(ndcX+1)/2, so
    // ndcX = -1 -> 0 and +1 -> w). The pixel flip `x -> w-1-x` (mirror.ts) is
    // index space; in edge space the identical map is `u -> w - u` (check: the
    // texel centre x+0.5 lands on w-x-0.5, the centre of texel w-1-x). Solving
    // u' - pivot' = -(u - pivot) with u' = w - u gives pivot' = w - pivot for
    // every u. Using w-1-x would put every feature one texel off AND break the
    // symmetric fixed point — a 64px feet-baseline pivot of 32 must mirror to
    // itself, and w-1-x gives 31.
    const pivotPx = source === undefined
      ? args.pivotPx
      : { x: r.w - args.pivotPx.x, y: args.pivotPx.y };
    return {
      clipId: r.id.clipId,
      direction: r.id.direction,
      frame: r.id.frame,
      pivotPx,
      atlas: { pageIndex: r.pageIndex, x: r.x, y: r.y, w: r.w, h: r.h },
      cacheHit: hit,
      ...(source === undefined ? {} : { mirroredFrom: { direction: source } }),
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
    ...(args.clips?.length ? { clips: args.clips } : {}),
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
