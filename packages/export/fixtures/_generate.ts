/**
 * Exporter fixture generator (deterministic; run once, files are checked in):
 * a hand-authored, schema-validated mini BakeManifest + synthetic atlas pages,
 * so the exporters are buildable and testable as pure projections BEFORE the
 * real packer exists (P2-T3 phase-0). Layout: clip 'idle', 2 directions x 2
 * frames, 16x16 cells in one row of a single 64x64 page per pass.
 *
 * Each lit/albedo/normal cell is a distinct solid color with a 2px transparent
 * margin and a darker 1px inner border, so any region-crop mistake in an
 * exporter is visually unmissable. depth/mask are gray16 with in/out contrast.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-ffi \
 *     packages/export/fixtures/_generate.ts
 */
import { encode as encodePng } from 'fast-png';
import { BakeManifestSchema, canonicalJson, parseWith, SCHEMA_VERSION } from '@spritebook/schema';

const here = new URL('.', import.meta.url);
const win = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const outDir = win(new URL('bake-aabbccdd/', here));
await Deno.mkdir(outDir, { recursive: true });

const PAGE = 64;
const CELL = 16;
const CELLS = [
  { clipId: 'idle', direction: 0, frame: 0, x: 0 },
  { clipId: 'idle', direction: 0, frame: 1, x: 16 },
  { clipId: 'idle', direction: 1, frame: 0, x: 32 },
  { clipId: 'idle', direction: 1, frame: 1, x: 48 },
];
// distinct fills per cell (r,g,b) — border is the same color at half intensity
const FILLS: Array<[number, number, number]> = [
  [200, 60, 60],
  [60, 200, 60],
  [60, 60, 200],
  [200, 200, 60],
];

function rgbaPage(shift: (c: [number, number, number]) => [number, number, number]): Uint8Array {
  const page = new Uint8Array(PAGE * PAGE * 4);
  CELLS.forEach((cell, i) => {
    const [r, g, b] = shift(FILLS[i]);
    for (let y = 2; y < CELL - 2; y++) {
      for (let x = 2; x < CELL - 2; x++) {
        const border = y === 2 || y === CELL - 3 || x === 2 || x === CELL - 3;
        const o = ((0 + y) * PAGE + cell.x + x) * 4;
        page[o] = border ? r >> 1 : r;
        page[o + 1] = border ? g >> 1 : g;
        page[o + 2] = border ? b >> 1 : b;
        page[o + 3] = 255;
      }
    }
  });
  return page;
}

function gray16Page(inside: number, outside: number): Uint16Array {
  const page = new Uint16Array(PAGE * PAGE).fill(0);
  CELLS.forEach((cell) => {
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const margin = y < 2 || y >= CELL - 2 || x < 2 || x >= CELL - 2;
        page[(0 + y) * PAGE + cell.x + x] = margin ? outside : inside;
      }
    }
  });
  return page;
}

const pages: Array<[string, Uint8Array]> = [
  ['atlas_lit_0.png', encodePng({ width: PAGE, height: PAGE, data: rgbaPage((c) => c) })],
  [
    'atlas_albedo_0.png',
    encodePng({ width: PAGE, height: PAGE, data: rgbaPage(([r, g, b]) => [b, r, g]) }),
  ],
  [
    'atlas_normal_0.png',
    encodePng({ width: PAGE, height: PAGE, data: rgbaPage(() => [128, 128, 255]) }),
  ],
  [
    'atlas_depth_0.png',
    encodePng({
      width: PAGE,
      height: PAGE,
      data: gray16Page(30000, 65535),
      channels: 1,
      depth: 16,
    }),
  ],
  [
    'atlas_mask_0.png',
    encodePng({ width: PAGE, height: PAGE, data: gray16Page(1, 0), channels: 1, depth: 16 }),
  ],
];
for (const [name, bytes] of pages) await Deno.writeFile(`${outDir}/${name}`, bytes);

const manifest = parseWith(BakeManifestSchema, {
  schemaVersion: SCHEMA_VERSION,
  bakeId: 'aabbccdd',
  characterId: 'fixture-char',
  inputs: {
    characterId: 'fixture-char',
    canonicalMeshSha256: 'a'.repeat(64),
    rigStateHash: 'b'.repeat(64),
    clipBindingHash: 'c'.repeat(64),
    cameraPresetHash: 'd'.repeat(64),
    stylePresetHash: 'e'.repeat(64),
    lightRigHash: 'd'.repeat(64),
    rendererVersion: 'spritebook-render@0.1.0',
    backend: { modelId: 'source-mesh', version: '0', paramsHash: 'f'.repeat(64) },
  },
  frames: CELLS.map((c) => ({
    clipId: c.clipId,
    direction: c.direction,
    frame: c.frame,
    pivotPx: { x: 8, y: 14 },
    atlas: { pageIndex: 0, x: c.x, y: 0, w: CELL, h: CELL },
    cacheHit: false,
  })),
  atlases: (['lit', 'albedo', 'normal', 'depth', 'mask'] as const).map((pass) => ({
    pageIndex: 0,
    pass,
    sizePx: PAGE,
    png: `atlas_${pass}_0.png`,
    layoutSharedWith: 'lit' as const,
  })),
  metrics: { flickerPct: 0.05, cacheHitPct: 0, wallTimeS: 1.5, framesTotal: 4 },
  flags: [],
  // 2 frames per direction over a 1 s clip at speed 1 -> 2 fps. A looping clip
  // here; the exporter tests clone this and flip holdLast to cover the
  // hold-last case without needing a second clip's worth of atlas cells.
  clips: [{ clipId: 'idle', frames: 2, speed: 1, holdLast: false, loop: true, fps: 2 }],
  createdAt: '2026-07-15T00:00:00.000Z',
}, 'fixture BakeManifest');

await Deno.writeTextFile(`${outDir}/manifest.json`, canonicalJson(manifest));
console.log(`exporter fixture written: ${outDir}`);
