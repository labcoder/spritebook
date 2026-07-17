/**
 * TexturePacker "JSON Hash" exporter (the flavor Phaser 3 / Unity consume) —
 * a pure projection of BakeManifest (D-010).
 *
 * Emits, per lit atlas page, `<characterId>.tp.json` plus the lit page PNG
 * copied VERBATIM into outDir (meta.image references the copied file name).
 * The `.tp.json` extension is deliberate: the Aseprite exporter writes
 * `<characterId>.ase.json` into the same outDir, so a bare `<characterId>.json`
 * would collide across exporters.
 *
 * Multi-page bakes emit one JSON per lit page with a `_p<pageIndex>` name
 * suffix (`<characterId>_p1.tp.json`); the suffix is omitted when there is
 * exactly one page. Each JSON hashes ONLY its page's frames, so animations
 * assembled from these names never span pages by construction.
 *
 * The hash is keyed by the canonical frame name `<clipId>_d<DD>_f<FFF>`,
 * inserted in (clipId, direction, frame) order. JSON.stringify preserves
 * string-key insertion order (the names are never integer-like), so the wire
 * order is deterministic.
 *
 * pivot is FrameRecord.pivotPx normalized by the CELL size — {x: pivotPx.x / w,
 * y: pivotPx.y / h} — rounded to at most 6 decimals via Number(v.toFixed(6))
 * so float noise (0.30000000000000004-style) can never reach the bytes. This
 * format carries no durations: timing belongs to the consumer (e.g. Phaser's
 * frameRate at anim creation), so opts.fps is deliberately unused.
 *
 * BYTE-STABILITY DOCTRINE (packages/pack/contracts.ts): the output is a pure
 * function of the manifest's stable fields. Never read the clock; never
 * project `createdAt` / `metrics.wallTimeS` / `metrics.cacheHitPct`. Every
 * object is literal-constructed in a FIXED key order and serialized as
 * `JSON.stringify(doc, null, 2) + '\n'` (LF), so exporting an unchanged bake
 * is byte-identical.
 *
 * Cells are packed as full rects (no trim, no rotation), hence
 * spriteSourceSize = {0, 0, w, h}, sourceSize = {w, h}, and rotated = trimmed
 * = false.
 */
import type { FrameRecord } from '@spritebook/schema';
import type { Exporter } from '../pack/contracts.ts';

const META_APP = 'spritebook';
/** Projected as meta.version — a frozen format constant, never read at runtime. */
const META_VERSION = '0.1.0';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Size {
  w: number;
  h: number;
}

/** One value of the "JSON Hash" frames object — key order here is the wire order. */
interface TexturePackerFrame {
  frame: Rect;
  rotated: false;
  trimmed: false;
  spriteSourceSize: Rect;
  sourceSize: Size;
  pivot: { x: number; y: number };
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** Canonical frame name: `<clipId>_d<DD>_f<FFF>` (zero-padded 2/3). */
const frameName = (f: FrameRecord): string =>
  `${f.clipId}_d${pad(f.direction, 2)}_f${pad(f.frame, 3)}`;

/** Deterministic frame order: (clipId, direction, frame); code-unit string compare. */
function byClipDirFrame(a: FrameRecord, b: FrameRecord): number {
  if (a.clipId !== b.clipId) return a.clipId < b.clipId ? -1 : 1;
  if (a.direction !== b.direction) return a.direction - b.direction;
  return a.frame - b.frame;
}

/** Deterministic decimal: at most 6 decimals, exact for the halves/eighths pivots use. */
const round6 = (v: number): number => Number(v.toFixed(6));

/** AtlasPage.png is bake-dir-relative; the copy in outDir is flat (its base name). */
const baseName = (relPath: string): string => relPath.split('/').at(-1) ?? relPath;

export const exportTexturePacker: Exporter = async (manifest, bakeDir, outDir, _opts) => {
  const litPages = manifest.atlases
    .filter((a) => a.pass === 'lit')
    .toSorted((a, b) => a.pageIndex - b.pageIndex);
  const sortedFrames = manifest.frames.toSorted(byClipDirFrame);
  await Deno.mkdir(outDir, { recursive: true });

  const written: string[] = [];
  for (const page of litPages) {
    const frames = sortedFrames.filter((f) => f.atlas.pageIndex === page.pageIndex);
    const image = baseName(page.png);
    const suffix = litPages.length === 1 ? '' : `_p${page.pageIndex}`;
    const jsonPath = `${outDir}/${manifest.characterId}${suffix}.tp.json`;
    const pngPath = `${outDir}/${image}`;

    const hash: Record<string, TexturePackerFrame> = {};
    for (const f of frames) {
      hash[frameName(f)] = {
        frame: { x: f.atlas.x, y: f.atlas.y, w: f.atlas.w, h: f.atlas.h },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: f.atlas.w, h: f.atlas.h },
        sourceSize: { w: f.atlas.w, h: f.atlas.h },
        pivot: { x: round6(f.pivotPx.x / f.atlas.w), y: round6(f.pivotPx.y / f.atlas.h) },
      };
    }

    const doc = {
      frames: hash,
      meta: {
        app: META_APP,
        version: META_VERSION,
        image,
        format: 'RGBA8888',
        size: { w: page.sizePx, h: page.sizePx },
        scale: '1',
      },
    };

    await Deno.copyFile(`${bakeDir}/${page.png}`, pngPath);
    await Deno.writeTextFile(jsonPath, JSON.stringify(doc, null, 2) + '\n');
    written.push(jsonPath, pngPath);
  }
  return written.toSorted();
};
