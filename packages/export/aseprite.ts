import { promises as fs } from 'node:fs';
/**
 * Aseprite "JSON (array)" exporter — a pure projection of BakeManifest (D-010).
 *
 * Emits, per lit atlas page, `<characterId>.ase.json` plus the lit page PNG
 * copied VERBATIM into outDir (meta.image references the copied file name).
 * The `.ase.json` extension is deliberate: the TexturePacker exporter writes
 * `<characterId>.tp.json` into the same outDir, so a bare `<characterId>.json`
 * would collide across exporters.
 *
 * Multi-page bakes emit one JSON per lit page with a `_p<pageIndex>` name
 * suffix (`<characterId>_p1.ase.json`); the suffix is omitted when there is
 * exactly one page. Each JSON contains ONLY its page's frames, and frameTags
 * index into that page-local frames array — tags therefore never span pages
 * by construction.
 *
 * BYTE-STABILITY DOCTRINE (packages/pack/contracts.ts): the output is a pure
 * function of the manifest's stable fields and opts.fps. Never read the clock;
 * never project `createdAt` / `metrics.wallTimeS` / `metrics.cacheHitPct`.
 * Every object is literal-constructed in a FIXED key order and serialized as
 * `JSON.stringify(doc, null, 2) + '\n'` (LF), so exporting an unchanged bake
 * is byte-identical.
 *
 * Cells are packed as full rects (no trim, no rotation), hence
 * spriteSourceSize = {0, 0, w, h}, sourceSize = {w, h}, and rotated = trimmed
 * = false.
 *
 * TIMING: `duration` is Math.round(1000 / fps) ms of the CLIP that frame
 * belongs to, from `BakeManifest.clips`; opts.fps is the fallback for a bake
 * that recorded no timing. Loop/hold is NOT projected: the Aseprite JSON has
 * no loop flag, and a frameTag's optional `repeat` is a play COUNT, not a loop
 * boolean — emitting one would be guessing. Consumers that need it read
 * `clips[].loop` from the manifest (or export godot/strips, which carry it).
 */
import type { FrameRecord } from '@spritebook/schema';
import type { Exporter } from '@spritebook/pack/contracts';
import { assertNoSplitAnimations } from './split-guard.ts';
import { atlasFiles } from './files.ts';

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

/** One entry of the "JSON (array)" frames list — key order here is the wire order. */
interface AsepriteFrame {
  filename: string;
  frame: Rect;
  rotated: false;
  trimmed: false;
  spriteSourceSize: Rect;
  sourceSize: Size;
  duration: number;
}

/** One tag per (clipId, direction); from/to index the page-local frames array. */
interface AsepriteFrameTag {
  name: string;
  from: number;
  to: number;
  direction: 'forward';
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

/** Contiguous (clipId, direction) runs of an already-sorted page-local frame list. */
function frameTags(frames: FrameRecord[]): AsepriteFrameTag[] {
  const tags: AsepriteFrameTag[] = [];
  frames.forEach((f, i) => {
    const name = `${f.clipId}_d${pad(f.direction, 2)}`;
    const last = tags.at(-1);
    if (last && last.name === name) last.to = i;
    else tags.push({ name, from: i, to: i, direction: 'forward' });
  });
  return tags;
}

export const exportAseprite: Exporter = async (manifest, bakeDir, outDir, opts) => {
  if (!Number.isFinite(opts.fps) || opts.fps <= 0) {
    throw new RangeError(`exportAseprite: fps must be positive and finite, got ${opts.fps}`);
  }
  assertNoSplitAnimations(manifest, 'exportAseprite');
  // per-clip ms, so clips of different lengths keep their own rates; `clips` is
  // optional, so an untimed clip falls back to opts.fps as before
  const timingByClip = new Map((manifest.clips ?? []).map((c) => [c.clipId, c]));
  const durationOf = (f: FrameRecord): number =>
    Math.round(1000 / (timingByClip.get(f.clipId)?.fps ?? opts.fps));
  const litPages = manifest.atlases
    .filter((a) => a.pass === 'lit')
    .toSorted((a, b) => a.pageIndex - b.pageIndex);
  // refuse an unprojectable manifest BEFORE touching the filesystem, the way
  // godot.ts and strips.ts do: an empty outDir plus [] reads as a successful
  // export of nothing
  if (litPages.length === 0) throw new Error('exportAseprite: manifest has no lit atlas pages');
  if (manifest.frames.length === 0) throw new Error('exportAseprite: manifest has no frames');
  const sortedFrames = manifest.frames.toSorted(byClipDirFrame);
  const files = await atlasFiles(manifest, bakeDir);
  await fs.mkdir(outDir, { recursive: true });

  const written: string[] = [];
  for (const page of litPages) {
    const frames = sortedFrames.filter((f) => f.atlas.pageIndex === page.pageIndex);
    const { name: image, source } = files.get(page.png)!;
    const suffix = litPages.length === 1 ? '' : `_p${page.pageIndex}`;
    const jsonPath = `${outDir}/${manifest.characterId}${suffix}.ase.json`;
    const pngPath = `${outDir}/${image}`;

    const doc = {
      frames: frames.map((f): AsepriteFrame => ({
        filename: frameName(f),
        frame: { x: f.atlas.x, y: f.atlas.y, w: f.atlas.w, h: f.atlas.h },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: f.atlas.w, h: f.atlas.h },
        sourceSize: { w: f.atlas.w, h: f.atlas.h },
        duration: durationOf(f),
      })),
      meta: {
        app: META_APP,
        version: META_VERSION,
        image,
        format: 'RGBA8888',
        size: { w: page.sizePx, h: page.sizePx },
        scale: '1',
        frameTags: frameTags(frames),
      },
    };

    await fs.copyFile(source, pngPath);
    await fs.writeFile(jsonPath, JSON.stringify(doc, null, 2) + '\n');
    written.push(jsonPath, pngPath);
  }
  return written.toSorted();
};
