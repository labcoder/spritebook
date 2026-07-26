/**
 * Strip exporter tests against the checked-in fixture bake: crop correctness
 * is proven pixel-by-pixel against the atlas page, the meta JSON is checked
 * byte-exactly (fixed key order), and the doctrine test proves the projection
 * is byte-stable.
 */
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { decode as decodePng } from 'fast-png';
import { type BakeManifest, BakeManifestSchema, parseWith } from '@spritebook/schema';
import { DEFAULT_FPS } from '../pack/contracts.ts';
import { exportStrips, type StripsMeta } from './strips.ts';

const win = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FIXTURE_DIR = win(new URL('fixtures/bake-aabbccdd', import.meta.url));

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

async function fixtureManifest(): Promise<BakeManifest> {
  const raw = JSON.parse(await Deno.readTextFile(`${FIXTURE_DIR}/manifest.json`));
  return parseWith(BakeManifestSchema, raw, 'fixture BakeManifest');
}

/** Crop a w*h RGBA block out of an imgW-wide RGBA plane. */
function crop(data: Uint8Array, imgW: number, x: number, y: number, w: number, h: number) {
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * imgW + x) * 4;
    out.set(data.subarray(src, src + w * 4), row * w * 4);
  }
  return out;
}

Deno.test('exportStrips: fixture -> 2 strips + meta json, sorted paths', async () => {
  const manifest = await fixtureManifest();
  const out = await Deno.makeTempDir({ prefix: 'sb-strips-' });
  try {
    const paths = await exportStrips(manifest, FIXTURE_DIR, out, { fps: DEFAULT_FPS });
    assertEquals(paths, [...paths].sort(), 'returned paths must be sorted');
    assertEquals(paths.map(baseName), [
      'fixture-char-idle-d00-strip.png',
      'fixture-char-idle-d01-strip.png',
      'fixture-char-strips.json',
    ]);
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('exportStrips: strip pixels match the atlas page rects exactly', async () => {
  const manifest = await fixtureManifest();
  const out = await Deno.makeTempDir({ prefix: 'sb-strips-' });
  try {
    await exportStrips(manifest, FIXTURE_DIR, out, { fps: DEFAULT_FPS });
    const page = decodePng(await Deno.readFile(`${FIXTURE_DIR}/atlas_lit_0.png`));
    const pageData = page.data as Uint8Array;
    // fixture layout: d00 frames at page x = 0, 16; d01 frames at x = 32, 48
    const cases = [
      { file: 'fixture-char-idle-d00-strip.png', srcX: [0, 16] },
      { file: 'fixture-char-idle-d01-strip.png', srcX: [32, 48] },
    ];
    for (const c of cases) {
      const strip = decodePng(await Deno.readFile(`${out}/${c.file}`));
      assertEquals(strip.width, 32, `${c.file} width`);
      assertEquals(strip.height, 16, `${c.file} height`);
      assertEquals(strip.channels, 4, `${c.file} channels`);
      const stripData = strip.data as Uint8Array;
      for (const [i, sx] of c.srcX.entries()) {
        assertEquals(
          crop(stripData, 32, i * 16, 0, 16, 16),
          crop(pageData, 64, sx, 0, 16, 16),
          `${c.file} cell ${i} != page rect at x=${sx}`,
        );
      }
    }
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('exportStrips: meta json is byte-exact with a fixed key order', async () => {
  const manifest = await fixtureManifest();
  const out = await Deno.makeTempDir({ prefix: 'sb-strips-' });
  try {
    await exportStrips(manifest, FIXTURE_DIR, out, { fps: DEFAULT_FPS });
    const expected = {
      cellPx: { w: 16, h: 16 },
      fps: 8,
      pivotPx: {
        d00: { x: 8, y: 14 },
        d01: { x: 8, y: 14 },
      },
      // per-strip fps is the CLIP's rate (fixture clip records 2), never the
      // export-wide meta.fps default above
      strips: [
        {
          file: 'fixture-char-idle-d00-strip.png',
          clipId: 'idle',
          direction: 0,
          frames: 2,
          fps: 2,
          loop: true,
        },
        {
          file: 'fixture-char-idle-d01-strip.png',
          clipId: 'idle',
          direction: 1,
          frames: 2,
          fps: 2,
          loop: true,
        },
      ],
    };
    assertEquals(
      await Deno.readTextFile(`${out}/fixture-char-strips.json`),
      JSON.stringify(expected, null, 2) + '\n',
    );
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('exportStrips: each strip carries its own clip rate and loop mode', async () => {
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
    { clipId: 'death01', frames: 1, speed: 1, holdLast: true, loop: false, fps: 12 },
    { clipId: 'idle', frames: 2, speed: 1, holdLast: false, loop: true, fps: 2 },
  ];
  const manifest = parseWith(BakeManifestSchema, plain, 'two-clip manifest');
  const out = await Deno.makeTempDir({ prefix: 'sb-strips-clips-' });
  try {
    await exportStrips(manifest, FIXTURE_DIR, out, { fps: DEFAULT_FPS });
    const meta = JSON.parse(
      await Deno.readTextFile(`${out}/fixture-char-strips.json`),
    ) as StripsMeta;
    assertEquals(
      meta.strips.map((s) => [s.clipId, s.direction, s.fps, s.loop]),
      [
        ['death01', 0, 12, false],
        ['death01', 1, 12, false],
        ['idle', 0, 2, true],
        ['idle', 1, 2, true],
      ],
      'one --fps must not flatten two clips onto one rate',
    );
    assertEquals(meta.fps, DEFAULT_FPS, 'meta.fps stays the export-wide default');
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('exportStrips: an untimed bake falls back to opts.fps and loops', async () => {
  const plain = structuredClone(await fixtureManifest());
  delete plain.clips;
  const manifest = parseWith(BakeManifestSchema, plain, 'legacy idle manifest');
  const out = await Deno.makeTempDir({ prefix: 'sb-strips-legacy-' });
  try {
    await exportStrips(manifest, FIXTURE_DIR, out, { fps: 24 });
    const meta = JSON.parse(
      await Deno.readTextFile(`${out}/fixture-char-strips.json`),
    ) as StripsMeta;
    assertEquals(meta.strips.map((s) => [s.fps, s.loop]), [[24, true], [24, true]]);
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('exportStrips: double export is byte-identical (byte-stability doctrine)', async () => {
  const manifest = await fixtureManifest();
  const outA = await Deno.makeTempDir({ prefix: 'sb-strips-a-' });
  const outB = await Deno.makeTempDir({ prefix: 'sb-strips-b-' });
  try {
    const a = await exportStrips(manifest, FIXTURE_DIR, outA, { fps: DEFAULT_FPS });
    const b = await exportStrips(manifest, FIXTURE_DIR, outB, { fps: DEFAULT_FPS });
    assertEquals(a.map(baseName), b.map(baseName));
    for (let i = 0; i < a.length; i++) {
      assertEquals(
        await Deno.readFile(a[i]),
        await Deno.readFile(b[i]),
        `bytes differ: ${baseName(a[i])}`,
      );
    }
  } finally {
    await Deno.remove(outA, { recursive: true });
    await Deno.remove(outB, { recursive: true });
  }
});

Deno.test('exportStrips: an empty manifest is refused before outDir exists', async () => {
  // all four exporters draw ONE boundary: refuse, and leave nothing behind
  const base = await fixtureManifest();
  const parent = await Deno.makeTempDir({ prefix: 'sb-strips-empty-' });
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
      await assertRejects(
        () => exportStrips(manifest, FIXTURE_DIR, out, { fps: DEFAULT_FPS }),
        Error,
        c.msg,
      );
      await assertRejects(
        () => Deno.stat(out),
        Deno.errors.NotFound,
        undefined,
        `${c.name}: a refusal must not leave an output directory behind`,
      );
    }
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test('exportStrips: non-uniform cell size throws', async () => {
  const manifest = await fixtureManifest();
  const bad = structuredClone(manifest);
  bad.frames[1].atlas.w = 8;
  const out = await Deno.makeTempDir({ prefix: 'sb-strips-' });
  try {
    await assertRejects(
      () => exportStrips(bad, FIXTURE_DIR, out, { fps: DEFAULT_FPS }),
      Error,
      'cells must be uniform',
    );
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});
