import { rejects } from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * exportAseprite against the checked-in fixture bake (bake-aabbccdd: clip
 * 'idle', 2 directions x 2 frames, 16x16 cells on one 64x64 lit page, pivot
 * (8,14)) plus a synthesized two-page variant for the `_p<i>` naming rule.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import type { BakeManifest } from '@spritebook/schema';
import { exportAseprite } from './dist/aseprite.js';

const BAKE = new URL('./fixtures/bake-aabbccdd', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

async function fixtureManifest(): Promise<BakeManifest> {
  const raw = JSON.parse(await fs.readFile(`${BAKE}/manifest.json`, 'utf8'));
  return parseWith(BakeManifestSchema, raw, 'fixture BakeManifest');
}

/** Fixture manifest split onto two lit pages: direction 1 moves to page 1. */
async function twoPageBake(base: BakeManifest): Promise<{ manifest: BakeManifest; dir: string }> {
  const plain = structuredClone(base);
  for (const f of plain.frames) if (f.direction === 1) f.atlas.pageIndex = 1;
  plain.atlases.push({
    pageIndex: 1,
    pass: 'lit',
    sizePx: 64,
    png: 'atlas_lit_1.png',
    layoutSharedWith: 'lit',
  });
  const dir = await fs.mkdtemp(join(tmpdir(), 'sb-ase-bake2p-'));
  await fs.copyFile(`${BAKE}/atlas_lit_0.png`, `${dir}/atlas_lit_0.png`);
  await fs.copyFile(`${BAKE}/atlas_lit_0.png`, `${dir}/atlas_lit_1.png`);
  return { manifest: parseWith(BakeManifestSchema, plain, 'two-page fixture manifest'), dir };
}

const expectedFrame = (filename: string, x: number, duration: number) => ({
  filename,
  frame: { x, y: 0, w: 16, h: 16 },
  rotated: false,
  trimmed: false,
  spriteSourceSize: { x: 0, y: 0, w: 16, h: 16 },
  sourceSize: { w: 16, h: 16 },
  duration,
});

test('exportAseprite projects sorted frames, tags, and meta from the fixture', async () => {
  const manifest = await fixtureManifest();
  const out = await fs.mkdtemp(join(tmpdir(), 'sb-ase-'));
  const written = await exportAseprite(manifest, BAKE, out, { fps: 8 });

  const jsonPath = `${out}/fixture-char.ase.json`;
  const pngPath = `${out}/atlas_lit_0.png`;
  assertEquals(written, [jsonPath, pngPath].toSorted(), 'returns the sorted written paths');

  const raw = await fs.readFile(jsonPath, 'utf8');
  const doc = JSON.parse(raw);
  // 500 ms = 1000 / the fixture clip's own fps of 2, NOT 1000 / opts.fps (8)
  assertEquals(doc, {
    frames: [
      expectedFrame('idle_d00_f000', 0, 500),
      expectedFrame('idle_d00_f001', 16, 500),
      expectedFrame('idle_d01_f000', 32, 500),
      expectedFrame('idle_d01_f001', 48, 500),
    ],
    meta: {
      app: 'spritebook',
      version: '0.1.0',
      image: 'atlas_lit_0.png',
      format: 'RGBA8888',
      size: { w: 64, h: 64 },
      scale: '1',
      frameTags: [
        { name: 'idle_d00', from: 0, to: 1, direction: 'forward' },
        { name: 'idle_d01', from: 2, to: 3, direction: 'forward' },
      ],
    },
  });
  assertEquals(JSON.stringify(doc, null, 2) + '\n', raw, 'JSON.parse round-trips byte-identically');
  assertEquals(
    new Uint8Array(await fs.readFile(pngPath)),
    new Uint8Array(await fs.readFile(`${BAKE}/atlas_lit_0.png`)),
    'lit page copied verbatim',
  );
  for (const needle of ['2026-07-15', 'createdAt', 'wallTimeS', 'cacheHitPct']) {
    assert(!raw.includes(needle), `volatile field text "${needle}" leaked into the export`);
  }
});

test('exportAseprite durations follow each clip own rate, not one --fps', async () => {
  // Aseprite's format carries per-frame ms, so clips of different lengths must
  // not be flattened onto one rate the way `export --fps` used to do
  const plain = structuredClone(await fixtureManifest());
  for (const direction of [0, 1]) {
    plain.frames.push({
      clipId: 'death01',
      direction,
      frame: 0,
      pivotPx: { x: 8, y: 14 },
      atlas: { pageIndex: 0, x: direction * 16, y: 16, w: 16, h: 16 },
      cacheHit: false,
    });
  }
  plain.clips = [
    { clipId: 'death01', frames: 1, speed: 1, holdLast: true, loop: false, fps: 24 },
    { clipId: 'idle', frames: 2, speed: 1, holdLast: false, loop: true, fps: 2 },
  ];
  const manifest = parseWith(BakeManifestSchema, plain, 'two-clip manifest');
  const out = await fs.mkdtemp(join(tmpdir(), 'sb-ase-fps-'));
  await exportAseprite(manifest, BAKE, out, { fps: 8 });
  const doc = JSON.parse(await fs.readFile(`${out}/fixture-char.ase.json`, 'utf8'));
  assertEquals(
    doc.frames.map((f: { filename: string; duration: number }) => [f.filename, f.duration]),
    [
      ['death01_d00_f000', 42], // 1000/24
      ['death01_d01_f000', 42],
      ['idle_d00_f000', 500], // 1000/2
      ['idle_d00_f001', 500],
      ['idle_d01_f000', 500],
      ['idle_d01_f001', 500],
    ],
  );
  assert(
    !doc.frames.some((f: { duration: number }) => f.duration === 125),
    'opts.fps (8 -> 125ms) must not reach a timed clip',
  );
});

test('exportAseprite falls back to opts.fps when the bake recorded no clips', async () => {
  const plain = structuredClone(await fixtureManifest());
  delete plain.clips;
  const manifest = parseWith(BakeManifestSchema, plain, 'legacy idle manifest');
  const out = await fs.mkdtemp(join(tmpdir(), 'sb-ase-legacy-'));
  await exportAseprite(manifest, BAKE, out, { fps: 24 });
  const doc = JSON.parse(await fs.readFile(`${out}/fixture-char.ase.json`, 'utf8'));
  assertEquals(
    doc.frames.map((f: { duration: number }) => f.duration),
    [42, 42, 42, 42],
    '1000/24 rounds to 42ms',
  );
});

test('exportAseprite double export is byte-identical (byte-stability doctrine)', async () => {
  const manifest = await fixtureManifest();
  // input frame order must be irrelevant: the second export sees reversed frames
  const reversed = parseWith(
    BakeManifestSchema,
    { ...manifest, frames: manifest.frames.toReversed() },
    'reversed fixture manifest',
  );
  const a = await fs.mkdtemp(join(tmpdir(), 'sb-ase-a-'));
  const b = await fs.mkdtemp(join(tmpdir(), 'sb-ase-b-'));
  const wroteA = await exportAseprite(manifest, BAKE, a, { fps: 8 });
  const wroteB = await exportAseprite(reversed, BAKE, b, { fps: 8 });

  assertEquals(wroteA.map((p) => p.slice(a.length)), wroteB.map((p) => p.slice(b.length)));
  for (let i = 0; i < wroteA.length; i++) {
    assertEquals(
      new Uint8Array(await fs.readFile(wroteA[i])),
      new Uint8Array(await fs.readFile(wroteB[i])),
      `${wroteA[i].slice(a.length)} is byte-identical across exports`,
    );
  }
});

test('exportAseprite emits one JSON per lit page with page-local tags', async () => {
  const { manifest, dir } = await twoPageBake(await fixtureManifest());
  const out = await fs.mkdtemp(join(tmpdir(), 'sb-ase-2p-'));
  const written = await exportAseprite(manifest, dir, out, { fps: 8 });

  assertEquals(
    written,
    [
      `${out}/atlas_lit_0.png`,
      `${out}/atlas_lit_1.png`,
      `${out}/fixture-char_p0.ase.json`,
      `${out}/fixture-char_p1.ase.json`,
    ].toSorted(),
    'page-suffixed JSON per lit page plus both page PNGs',
  );
  const p0 = JSON.parse(await fs.readFile(`${out}/fixture-char_p0.ase.json`, 'utf8'));
  const p1 = JSON.parse(await fs.readFile(`${out}/fixture-char_p1.ase.json`, 'utf8'));
  const names = (doc: { frames: { filename: string }[] }) => doc.frames.map((f) => f.filename);
  assertEquals(names(p0), ['idle_d00_f000', 'idle_d00_f001']);
  assertEquals(names(p1), ['idle_d01_f000', 'idle_d01_f001']);
  assertEquals(p0.meta.image, 'atlas_lit_0.png');
  assertEquals(p1.meta.image, 'atlas_lit_1.png');
  // from/to restart per page: tags never reference frames outside their own page
  assertEquals(p0.meta.frameTags, [{ name: 'idle_d00', from: 0, to: 1, direction: 'forward' }]);
  assertEquals(p1.meta.frameTags, [{ name: 'idle_d01', from: 0, to: 1, direction: 'forward' }]);
});

test('exportAseprite refuses an empty manifest instead of writing an empty dir', async () => {
  // godot.ts and strips.ts throw here; aseprite used to iterate zero lit pages,
  // mkdir the target and return [] — an export that "succeeded" with no output
  const base = await fixtureManifest();
  const parent = await fs.mkdtemp(join(tmpdir(), 'sb-ase-empty-'));
  try {
    const cases: Array<{ name: string; patch: (m: BakeManifest) => void; msg: string }> = [
      { name: 'no-pages', patch: (m) => void (m.atlases = []), msg: 'no lit atlas pages' },
      { name: 'no-frames', patch: (m) => void (m.frames = []), msg: 'no frames' },
    ];
    for (const c of cases) {
      const plain = structuredClone(base);
      c.patch(plain);
      const manifest = parseWith(BakeManifestSchema, plain, `${c.name} manifest`);
      const out = `${parent}/${c.name}`;
      await assertRejects(() => exportAseprite(manifest, BAKE, out, { fps: 8 }), Error, c.msg);
      await rejects(
        () => fs.stat(out), { code: 'ENOENT' },
        `${c.name}: a refusal must not leave an output directory behind`,
      );
    }
  } finally {
    await fs.rm(parent, { recursive: true });
  }
});

test('exportAseprite refuses an animation split across pages (M1 guard)', async () => {
  // move ONLY idle/d01/f001 to page 1: group idle_d01 now spans pages 0 and 1,
  // so any per-page JSON would truncate the animation - must throw, not lie
  const base = await fixtureManifest();
  const plain = structuredClone(base);
  for (const f of plain.frames) {
    if (f.direction === 1 && f.frame === 1) f.atlas.pageIndex = 1;
  }
  plain.atlases.push({
    pageIndex: 1,
    pass: 'lit',
    sizePx: 64,
    png: 'atlas_lit_1.png',
    layoutSharedWith: 'lit',
  });
  const manifest = parseWith(BakeManifestSchema, plain, 'split-group manifest');
  const out = await fs.mkdtemp(join(tmpdir(), 'sb-ase-split-'));
  try {
    let threw = false;
    try {
      await exportAseprite(manifest, BAKE, out, { fps: 8 });
    } catch (err) {
      threw = true;
      assert(err instanceof Error && err.message.includes('idle_d01'), `names the group: ${err}`);
      assert(err.message.includes('spans atlas pages'), 'explains the failure');
    }
    assert(threw, 'split animation must throw');
  } finally {
    await fs.rm(out, { recursive: true });
  }
});
