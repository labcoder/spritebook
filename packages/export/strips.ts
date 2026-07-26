/**
 * Raw horizontal strip exporter — a PURE PROJECTION of BakeManifest (D-010).
 *
 * Per (clipId, direction): each frame's rect is cropped out of the lit atlas
 * page(s) in canonical frame order and laid left-to-right into one
 * `<characterId>-<clipId>-d<DD>-strip.png` (height = cell h, width =
 * frames * cell w). One `<characterId>-strips.json` describes the set, built
 * with a FIXED key order so the bytes never move (byte-stability doctrine,
 * packages/pack/contracts.ts). fast-png decodes and encodes losslessly, so
 * pixels cross unchanged; the single meta cellPx forces cells to be uniform
 * across the whole bake, which subsumes the per-strip uniformity assert.
 *
 * TIMING: each strip carries its clip's own `fps` and `loop` from
 * `BakeManifest.clips` — this sidecar is our own format, so there is no reason
 * to flatten clips of different lengths onto one rate. `meta.fps` is only the
 * default an untimed clip falls back to.
 */
import { decode as decodePng, encode as encodePng } from 'fast-png';
import type { FrameRecord } from '@spritebook/schema';
import type { Exporter } from '../pack/contracts.ts';
import { frameIdKey } from '../pack/contracts.ts';

/** The schema leaves clipId free-form; file names must not be. */
const SAFE_CLIP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Canonical frame order (clipId, direction, frame); code-unit compare, locale-free. */
function compareFrames(a: FrameRecord, b: FrameRecord): number {
  if (a.clipId !== b.clipId) return a.clipId < b.clipId ? -1 : 1;
  return a.direction - b.direction || a.frame - b.frame;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export interface StripEntry {
  file: string;
  clipId: string;
  direction: number;
  frames: number;
  /** this clip's own rate — meta.fps when the bake recorded no timing for it */
  fps: number;
  /** playback loops; false is a held clip (a death pose stops on its last frame) */
  loop: boolean;
}

/**
 * Shape of `<characterId>-strips.json` (fixed construction order = fixed bytes).
 * This sidecar is SpriteBook's own format, so it carries timing per strip; the
 * top-level `fps` is only the export-wide default that untimed clips fall back
 * to. Read `strips[].fps` / `strips[].loop`, not `fps`.
 */
export interface StripsMeta {
  cellPx: { w: number; h: number };
  fps: number;
  /** keyed `d<DD>`, pivot of the first frame of each direction */
  pivotPx: Record<string, { x: number; y: number }>;
  strips: StripEntry[];
}

interface DecodedPage {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Export one strip PNG per (clipId, direction) plus `<characterId>-strips.json`
 * into outDir; returns the written paths, sorted. Throws on manifests this
 * projection cannot represent: no frames, non-uniform cell sizes, dangling or
 * duplicate page references, rects outside the page, unsafe clip ids, or a
 * non-positive fps.
 */
export const exportStrips: Exporter = async (manifest, bakeDir, outDir, opts) => {
  if (!Number.isFinite(opts.fps) || opts.fps <= 0) {
    throw new Error(`exportStrips: fps must be a finite number > 0, got ${opts.fps}`);
  }
  const frames = [...manifest.frames].sort(compareFrames);
  if (frames.length === 0) throw new Error('exportStrips: manifest has no frames');

  const litPngByIndex = new Map<number, string>();
  for (const page of manifest.atlases) {
    if (page.pass !== 'lit') continue;
    if (litPngByIndex.has(page.pageIndex)) {
      throw new Error(`exportStrips: duplicate lit atlas pageIndex ${page.pageIndex}`);
    }
    litPngByIndex.set(page.pageIndex, page.png);
  }
  // upfront, so a page-less manifest is refused BEFORE outDir exists — the same
  // boundary godot.ts draws (an empty outDir reads as a successful export)
  if (litPngByIndex.size === 0) throw new Error('exportStrips: manifest has no lit atlas pages');

  const decoded = new Map<number, DecodedPage>();
  const litPage = async (f: FrameRecord): Promise<DecodedPage> => {
    const cached = decoded.get(f.atlas.pageIndex);
    if (cached !== undefined) return cached;
    const png = litPngByIndex.get(f.atlas.pageIndex);
    if (png === undefined) {
      throw new Error(
        `exportStrips: frame ${frameIdKey(f)} references atlas page ${f.atlas.pageIndex}, ` +
          'which has no lit page in the manifest',
      );
    }
    const img = decodePng(await Deno.readFile(`${bakeDir}/${png}`));
    if (img.channels !== 4 || img.depth !== 8) {
      throw new Error(
        `exportStrips: ${png} is not rgba8 (channels=${img.channels}, depth=${img.depth})`,
      );
    }
    const page = { width: img.width, height: img.height, data: img.data as Uint8Array };
    decoded.set(f.atlas.pageIndex, page);
    return page;
  };

  // the meta's single cellPx makes cell size a bake-wide invariant
  const cw = frames[0].atlas.w;
  const ch = frames[0].atlas.h;
  for (const f of frames) {
    if (!SAFE_CLIP_ID.test(f.clipId)) {
      throw new Error(`exportStrips: clipId '${f.clipId}' is not file-name safe`);
    }
    if (f.atlas.w !== cw || f.atlas.h !== ch) {
      throw new Error(
        `exportStrips: frame ${frameIdKey(f)} cell ${f.atlas.w}x${f.atlas.h} != ` +
          `cell ${cw}x${ch} (cells must be uniform)`,
      );
    }
  }

  const groups: Array<{ clipId: string; direction: number; frames: FrameRecord[] }> = [];
  for (const f of frames) {
    const last = groups.at(-1);
    if (last !== undefined && last.clipId === f.clipId && last.direction === f.direction) {
      last.frames.push(f);
    } else {
      groups.push({ clipId: f.clipId, direction: f.direction, frames: [f] });
    }
  }

  // per-clip timing when the bake recorded it; `clips` is optional, so an
  // untimed clip keeps the old behaviour (opts.fps, looping)
  const timingByClip = new Map((manifest.clips ?? []).map((c) => [c.clipId, c]));

  await Deno.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  const stripEntries: StripEntry[] = [];
  for (const g of groups) {
    const stripW = g.frames.length * cw;
    const strip = new Uint8Array(stripW * ch * 4);
    for (const [fi, f] of g.frames.entries()) {
      const page = await litPage(f);
      if (f.atlas.x + cw > page.width || f.atlas.y + ch > page.height) {
        throw new Error(
          `exportStrips: frame ${frameIdKey(f)} rect exceeds its ${page.width}x${page.height} page`,
        );
      }
      for (let y = 0; y < ch; y++) {
        const src = ((f.atlas.y + y) * page.width + f.atlas.x) * 4;
        strip.set(page.data.subarray(src, src + cw * 4), (y * stripW + fi * cw) * 4);
      }
    }
    const file = `${manifest.characterId}-${g.clipId}-d${pad2(g.direction)}-strip.png`;
    await Deno.writeFile(
      `${outDir}/${file}`,
      encodePng({ width: stripW, height: ch, data: strip }),
    );
    written.push(`${outDir}/${file}`);
    const timing = timingByClip.get(g.clipId);
    stripEntries.push({
      file,
      clipId: g.clipId,
      direction: g.direction,
      frames: g.frames.length,
      fps: timing?.fps ?? opts.fps,
      loop: timing?.loop ?? true,
    });
  }

  // pivot of the first frame of each direction, keys ascending — fixed order
  const pivotByDirection = new Map<number, { x: number; y: number }>();
  for (const f of frames) {
    if (!pivotByDirection.has(f.direction)) {
      pivotByDirection.set(f.direction, { x: f.pivotPx.x, y: f.pivotPx.y });
    }
  }
  const pivotPx: StripsMeta['pivotPx'] = {};
  for (const [d, p] of [...pivotByDirection.entries()].sort((a, b) => a[0] - b[0])) {
    pivotPx[`d${pad2(d)}`] = p;
  }

  const meta: StripsMeta = {
    cellPx: { w: cw, h: ch },
    // the export-wide DEFAULT; per-strip fps/loop above is the truth
    fps: opts.fps,
    pivotPx,
    strips: stripEntries,
  };
  const metaPath = `${outDir}/${manifest.characterId}-strips.json`;
  await Deno.writeTextFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
  written.push(metaPath);
  return written.sort();
};
