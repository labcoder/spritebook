/**
 * exportTexturePacker against the checked-in fixture bake (bake-aabbccdd:
 * clip 'idle', 2 directions x 2 frames, 16x16 cells on one 64x64 lit page,
 * pivot (8,14) -> normalized (0.5, 0.875)) plus a synthesized two-page
 * variant for the `_p<i>` naming rule.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import type { BakeManifest } from '@spritebook/schema';
import { exportTexturePacker } from './texturepacker.ts';

const BAKE = new URL('./fixtures/bake-aabbccdd', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

async function fixtureManifest(): Promise<BakeManifest> {
  const raw = JSON.parse(await Deno.readTextFile(`${BAKE}/manifest.json`));
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
  const dir = await Deno.makeTempDir({ prefix: 'sb-tp-bake2p-' });
  await Deno.copyFile(`${BAKE}/atlas_lit_0.png`, `${dir}/atlas_lit_0.png`);
  await Deno.copyFile(`${BAKE}/atlas_lit_0.png`, `${dir}/atlas_lit_1.png`);
  return { manifest: parseWith(BakeManifestSchema, plain, 'two-page fixture manifest'), dir };
}

const expectedEntry = (x: number) => ({
  frame: { x, y: 0, w: 16, h: 16 },
  rotated: false,
  trimmed: false,
  spriteSourceSize: { x: 0, y: 0, w: 16, h: 16 },
  sourceSize: { w: 16, h: 16 },
  pivot: { x: 0.5, y: 0.875 },
});

Deno.test('exportTexturePacker projects the hash with normalized pivots', async () => {
  const manifest = await fixtureManifest();
  const out = await Deno.makeTempDir({ prefix: 'sb-tp-' });
  const written = await exportTexturePacker(manifest, BAKE, out, { fps: 8 });

  const jsonPath = `${out}/fixture-char.tp.json`;
  const pngPath = `${out}/atlas_lit_0.png`;
  assertEquals(written, [jsonPath, pngPath].toSorted(), 'returns the sorted written paths');

  const raw = await Deno.readTextFile(jsonPath);
  const doc = JSON.parse(raw);
  assertEquals(doc, {
    frames: {
      idle_d00_f000: expectedEntry(0),
      idle_d00_f001: expectedEntry(16),
      idle_d01_f000: expectedEntry(32),
      idle_d01_f001: expectedEntry(48),
    },
    meta: {
      app: 'spritebook',
      version: '0.1.0',
      image: 'atlas_lit_0.png',
      format: 'RGBA8888',
      size: { w: 64, h: 64 },
      scale: '1',
    },
  });
  // hash key order is part of the bytes: keys serialize in (clip, dir, frame) order
  assertEquals(Object.keys(doc.frames), [
    'idle_d00_f000',
    'idle_d00_f001',
    'idle_d01_f000',
    'idle_d01_f001',
  ]);
  assertEquals(JSON.stringify(doc, null, 2) + '\n', raw, 'JSON.parse round-trips byte-identically');
  assertEquals(
    await Deno.readFile(pngPath),
    await Deno.readFile(`${BAKE}/atlas_lit_0.png`),
    'lit page copied verbatim',
  );
  for (const needle of ['2026-07-15', 'createdAt', 'wallTimeS', 'cacheHitPct']) {
    assert(!raw.includes(needle), `volatile field text "${needle}" leaked into the export`);
  }
});

Deno.test('exportTexturePacker frame rects stay within the page bounds', async () => {
  const manifest = await fixtureManifest();
  const out = await Deno.makeTempDir({ prefix: 'sb-tp-bounds-' });
  await exportTexturePacker(manifest, BAKE, out, { fps: 8 });
  const doc = JSON.parse(await Deno.readTextFile(`${out}/fixture-char.tp.json`)) as {
    frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
    meta: { size: { w: number; h: number } };
  };
  const names = Object.keys(doc.frames);
  assertEquals(names.length, 4, 'every fixture frame is keyed');
  for (const name of names) {
    const { x, y, w, h } = doc.frames[name].frame;
    assert(
      x >= 0 && y >= 0 && x + w <= doc.meta.size.w && y + h <= doc.meta.size.h,
      `${name} rect (${x},${y},${w},${h}) escapes the ${doc.meta.size.w}x${doc.meta.size.h} page`,
    );
  }
});

Deno.test('exportTexturePacker double export is byte-identical (byte-stability doctrine)', async () => {
  const manifest = await fixtureManifest();
  // input frame order must be irrelevant: the second export sees reversed frames
  const reversed = parseWith(
    BakeManifestSchema,
    { ...manifest, frames: manifest.frames.toReversed() },
    'reversed fixture manifest',
  );
  const a = await Deno.makeTempDir({ prefix: 'sb-tp-a-' });
  const b = await Deno.makeTempDir({ prefix: 'sb-tp-b-' });
  const wroteA = await exportTexturePacker(manifest, BAKE, a, { fps: 8 });
  const wroteB = await exportTexturePacker(reversed, BAKE, b, { fps: 8 });

  assertEquals(wroteA.map((p) => p.slice(a.length)), wroteB.map((p) => p.slice(b.length)));
  for (let i = 0; i < wroteA.length; i++) {
    assertEquals(
      await Deno.readFile(wroteA[i]),
      await Deno.readFile(wroteB[i]),
      `${wroteA[i].slice(a.length)} is byte-identical across exports`,
    );
  }
});

Deno.test('exportTexturePacker emits one hash JSON per lit page', async () => {
  const { manifest, dir } = await twoPageBake(await fixtureManifest());
  const out = await Deno.makeTempDir({ prefix: 'sb-tp-2p-' });
  const written = await exportTexturePacker(manifest, dir, out, { fps: 8 });

  assertEquals(
    written,
    [
      `${out}/atlas_lit_0.png`,
      `${out}/atlas_lit_1.png`,
      `${out}/fixture-char_p0.tp.json`,
      `${out}/fixture-char_p1.tp.json`,
    ].toSorted(),
    'page-suffixed JSON per lit page plus both page PNGs',
  );
  const p0 = JSON.parse(await Deno.readTextFile(`${out}/fixture-char_p0.tp.json`));
  const p1 = JSON.parse(await Deno.readTextFile(`${out}/fixture-char_p1.tp.json`));
  assertEquals(Object.keys(p0.frames), ['idle_d00_f000', 'idle_d00_f001']);
  assertEquals(Object.keys(p1.frames), ['idle_d01_f000', 'idle_d01_f001']);
  assertEquals(p0.meta.image, 'atlas_lit_0.png');
  assertEquals(p1.meta.image, 'atlas_lit_1.png');
});

Deno.test('exportTexturePacker refuses an animation split across pages (M1 guard)', async () => {
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
  const out = await Deno.makeTempDir({ prefix: 'sb-tp-split-' });
  try {
    let threw = false;
    try {
      await exportTexturePacker(manifest, BAKE, out, { fps: 8 });
    } catch (err) {
      threw = true;
      assert(err instanceof Error && err.message.includes('idle_d01'), `names the group: ${err}`);
    }
    assert(threw, 'split animation must throw');
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});
