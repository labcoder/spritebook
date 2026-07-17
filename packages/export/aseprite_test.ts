/**
 * exportAseprite against the checked-in fixture bake (bake-aabbccdd: clip
 * 'idle', 2 directions x 2 frames, 16x16 cells on one 64x64 lit page, pivot
 * (8,14)) plus a synthesized two-page variant for the `_p<i>` naming rule.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import type { BakeManifest } from '@spritebook/schema';
import { exportAseprite } from './aseprite.ts';

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
  const dir = await Deno.makeTempDir({ prefix: 'sb-ase-bake2p-' });
  await Deno.copyFile(`${BAKE}/atlas_lit_0.png`, `${dir}/atlas_lit_0.png`);
  await Deno.copyFile(`${BAKE}/atlas_lit_0.png`, `${dir}/atlas_lit_1.png`);
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

Deno.test('exportAseprite projects sorted frames, tags, and meta from the fixture', async () => {
  const manifest = await fixtureManifest();
  const out = await Deno.makeTempDir({ prefix: 'sb-ase-' });
  const written = await exportAseprite(manifest, BAKE, out, { fps: 8 });

  const jsonPath = `${out}/fixture-char.ase.json`;
  const pngPath = `${out}/atlas_lit_0.png`;
  assertEquals(written, [jsonPath, pngPath].toSorted(), 'returns the sorted written paths');

  const raw = await Deno.readTextFile(jsonPath);
  const doc = JSON.parse(raw);
  assertEquals(doc, {
    frames: [
      expectedFrame('idle_d00_f000', 0, 125),
      expectedFrame('idle_d00_f001', 16, 125),
      expectedFrame('idle_d01_f000', 32, 125),
      expectedFrame('idle_d01_f001', 48, 125),
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
    await Deno.readFile(pngPath),
    await Deno.readFile(`${BAKE}/atlas_lit_0.png`),
    'lit page copied verbatim',
  );
  for (const needle of ['2026-07-15', 'createdAt', 'wallTimeS', 'cacheHitPct']) {
    assert(!raw.includes(needle), `volatile field text "${needle}" leaked into the export`);
  }
});

Deno.test('exportAseprite durations follow opts.fps (round(1000 / fps))', async () => {
  const manifest = await fixtureManifest();
  const out = await Deno.makeTempDir({ prefix: 'sb-ase-fps-' });
  await exportAseprite(manifest, BAKE, out, { fps: 24 });
  const doc = JSON.parse(await Deno.readTextFile(`${out}/fixture-char.ase.json`));
  assertEquals(
    doc.frames.map((f: { duration: number }) => f.duration),
    [42, 42, 42, 42],
    '1000/24 rounds to 42ms',
  );
});

Deno.test('exportAseprite double export is byte-identical (byte-stability doctrine)', async () => {
  const manifest = await fixtureManifest();
  // input frame order must be irrelevant: the second export sees reversed frames
  const reversed = parseWith(
    BakeManifestSchema,
    { ...manifest, frames: manifest.frames.toReversed() },
    'reversed fixture manifest',
  );
  const a = await Deno.makeTempDir({ prefix: 'sb-ase-a-' });
  const b = await Deno.makeTempDir({ prefix: 'sb-ase-b-' });
  const wroteA = await exportAseprite(manifest, BAKE, a, { fps: 8 });
  const wroteB = await exportAseprite(reversed, BAKE, b, { fps: 8 });

  assertEquals(wroteA.map((p) => p.slice(a.length)), wroteB.map((p) => p.slice(b.length)));
  for (let i = 0; i < wroteA.length; i++) {
    assertEquals(
      await Deno.readFile(wroteA[i]),
      await Deno.readFile(wroteB[i]),
      `${wroteA[i].slice(a.length)} is byte-identical across exports`,
    );
  }
});

Deno.test('exportAseprite emits one JSON per lit page with page-local tags', async () => {
  const { manifest, dir } = await twoPageBake(await fixtureManifest());
  const out = await Deno.makeTempDir({ prefix: 'sb-ase-2p-' });
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
  const p0 = JSON.parse(await Deno.readTextFile(`${out}/fixture-char_p0.ase.json`));
  const p1 = JSON.parse(await Deno.readTextFile(`${out}/fixture-char_p1.ase.json`));
  const names = (doc: { frames: { filename: string }[] }) => doc.frames.map((f) => f.filename);
  assertEquals(names(p0), ['idle_d00_f000', 'idle_d00_f001']);
  assertEquals(names(p1), ['idle_d01_f000', 'idle_d01_f001']);
  assertEquals(p0.meta.image, 'atlas_lit_0.png');
  assertEquals(p1.meta.image, 'atlas_lit_1.png');
  // from/to restart per page: tags never reference frames outside their own page
  assertEquals(p0.meta.frameTags, [{ name: 'idle_d00', from: 0, to: 1, direction: 'forward' }]);
  assertEquals(p1.meta.frameTags, [{ name: 'idle_d01', from: 0, to: 1, direction: 'forward' }]);
});
