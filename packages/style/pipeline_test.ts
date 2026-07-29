/**
 * P2-T2 acceptance (structural — runs anywhere from the committed AOV fixtures,
 * no GPU): palette-membership across a full clip, the flicker metric + per-preset
 * budget, the outline-exceeds-padding QA flag, and same-inputs determinism. The
 * perceptual per-preset goldens live in goldens_test.ts.
 */
import { assert, assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import type { CameraPreset } from '@spritebook/schema';
import { parseWith, StylePresetSchema } from '@spritebook/schema';
import { styleFromAovs } from './pipeline.ts';
import { CEL_2, PAINTERLY, PIXEL_8, PRESETS } from './presets.ts';
import { srgbToHex } from './oklab.ts';
import type { AovSource } from './contracts.ts';

const FRAMES = new URL('./fixtures/aov/frames/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const SRC: AovSource = { framesDir: FRAMES, directions: 2, frames: 6, width: 256, height: 256 };
const CAM: CameraPreset = {
  id: 'style-fixture-30x2',
  elevationDeg: 30,
  directions: 2,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32,
  cellPx: { w: 64, h: 64 },
  paddingPx: 6,
  pivot: 'feet-baseline',
  orthographic: true,
};

const fn = (d: number, f: number) =>
  `d${String(d).padStart(2, '0')}_f${String(f).padStart(3, '0')}.png`;

Deno.test('presets load and validate', () => {
  assertEquals(Object.keys(PRESETS).sort(), ['cel-2', 'painterly', 'pixel-8']);
});

Deno.test('palette membership: every opaque pixel of a pixel style is a palette color', async () => {
  const out = await Deno.makeTempDir();
  try {
    const r = await styleFromAovs(SRC, CAM, PIXEL_8, out);
    const palette = new Set(r.paletteHex);
    let checked = 0;
    for (let d = 0; d < SRC.directions; d++) {
      for (let f = 0; f < SRC.frames; f++) {
        const img = decodePng(await Deno.readFile(`${r.styledDir}/${fn(d, f)}`));
        const data = img.data as Uint8Array;
        for (let p = 0; p < img.width * img.height; p++) {
          if (data[p * 4 + 3] === 0) continue; // transparent
          const hex = srgbToHex(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
          assert(palette.has(hex), `opaque pixel ${hex} not in palette`);
          checked++;
        }
      }
    }
    assert(checked > 1000, `enough opaque pixels checked (${checked})`);
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('flicker is within each preset budget on the idle loop', async () => {
  // Tight regression guards at ~2x MEASURED, not the roadmap 1.2% target - all
  // presets clear that with room. Measured: cel-2 0.054%, painterly 0.689%,
  // and pixel-8 0.273% since its stroke went to half a pixel: a 2-texel Sx
  // stroke sits at the cluster-vote margin, so an edge pixel can swing between
  // outline and surface with subpixel motion. That is the accepted price of an
  // outline that no longer swallows slim characters; the old 0.054% belongs to
  // the 1 px stroke and is not coming back with this preset.
  const budget: Record<string, number> = { 'pixel-8': 0.55, 'cel-2': 0.15, 'painterly': 1.0 };
  for (const [id, preset] of Object.entries(PRESETS)) {
    const out = await Deno.makeTempDir();
    try {
      const r = await styleFromAovs(SRC, CAM, preset, out);
      assert(
        r.flickerPct <= budget[id],
        `${id} flicker ${r.flickerPct.toFixed(3)}% exceeds budget ${budget[id]}%`,
      );
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  }
});

Deno.test('outline-exceeds-padding QA flag fires only when width > padding', async () => {
  // padding is 6; PIXEL_8 outline width 0.5 -> no flag
  const clean = await Deno.makeTempDir();
  try {
    const r = await styleFromAovs(SRC, CAM, PIXEL_8, clean);
    assert(!r.flags.some((f) => f.code === 'outline-exceeds-padding'), 'no flag at width 1');
  } finally {
    await Deno.remove(clean, { recursive: true });
  }
  // width 8 > padding 6 -> flag with sourceStage 'look' + frameRefs
  const wide = await Deno.makeTempDir();
  try {
    const preset = { ...PIXEL_8, outline: { ...PIXEL_8.outline!, widthPx: 8 } };
    const r = await styleFromAovs(SRC, CAM, preset, wide);
    const flag = r.flags.find((f) => f.code === 'outline-exceeds-padding');
    assert(flag, 'flag raised at width 8');
    assertEquals(flag!.sourceStage, 'look');
    assert(flag!.frameRefs.length > 0 && flag!.frameRefs[0].clipId.length > 0, 'frameRefs present');
  } finally {
    await Deno.remove(wide, { recursive: true });
  }
});

Deno.test('styleFromAovs is deterministic (byte-identical sprites + metrics)', async () => {
  const a = await Deno.makeTempDir(), b = await Deno.makeTempDir();
  try {
    const ra = await styleFromAovs(SRC, CAM, CEL_2, a);
    const rb = await styleFromAovs(SRC, CAM, CEL_2, b);
    assertEquals(ra.paletteHex, rb.paletteHex, 'palette identical');
    assertEquals(ra.flickerPct, rb.flickerPct, 'flicker identical');
    for (let d = 0; d < SRC.directions; d++) {
      for (let f = 0; f < SRC.frames; f++) {
        const pa = await Deno.readFile(`${a}/styled/${fn(d, f)}`);
        const pb = await Deno.readFile(`${b}/styled/${fn(d, f)}`);
        assertEquals(pa, pb, `${fn(d, f)} differs between renders`);
      }
    }
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test('painterly: a bigger budget never shrinks the palette, and no entry is dead', async () => {
  // This replaces an assertion that compared paletteHex.LENGTH against
  // pixel-8's maxColors. That passed while 25 of painterly's 32 entries were
  // duplicates of each other: it asserted the padding, not the palette. Entry
  // count was never the thing worth checking, because `nearestWithDist` breaks
  // ties with a strict `<`, so a duplicate entry can never be selected.
  const out = await Deno.makeTempDir();
  const out8 = await Deno.makeTempDir();
  try {
    const painterly = await styleFromAovs(SRC, CAM, PAINTERLY, out);
    const pixel = await styleFromAovs(SRC, CAM, PIXEL_8, out8);
    assertEquals(painterly.superSample, 4);

    // every reported entry is a colour the sprite can actually be painted with
    assertEquals(
      new Set(painterly.paletteHex).size,
      painterly.paletteHex.length,
      'painterly reports no duplicate palette entries',
    );
    assertEquals(
      new Set(pixel.paletteHex).size,
      pixel.paletteHex.length,
      'pixel-8 reports no duplicate palette entries',
    );

    // the larger budget can only ever help
    assert(
      painterly.paletteHex.length >= pixel.paletteHex.length,
      `painterly (${painterly.paletteHex.length}) must not be smaller than ` +
        `pixel-8 (${pixel.paletteHex.length})`,
    );
    assert(
      painterly.paletteHex.length <= PAINTERLY.quantize!.maxColors,
      'and never exceeds its own budget',
    );
    // On THIS fixture both saturate: the lit AOV of a flat-shaded box holds
    // exactly 8 distinct colours, so 8 is the ceiling for any maxColors >= 8.
    // A palette larger than the source would be invented colour.
    assertEquals(painterly.paletteHex.length, 8, "the fixture's own distinct-colour ceiling");
  } finally {
    await Deno.remove(out, { recursive: true });
    await Deno.remove(out8, { recursive: true });
  }
});

Deno.test('cluster-vote without a palette is refused, not silently blank', () => {
  // Measured before this guard: a schema-valid preset with clusterVote and no
  // quantize wrote 64x64 sprites with opaque=0 and reported flickerPct 0.000 —
  // a perfect stability score for an image containing nothing.
  // the schema refuses it outright, so the state cannot even be persisted
  const bad = { ...PIXEL_8, id: 'blank-maker', quantize: undefined };
  assertThrows(() => parseWith(StylePresetSchema, bad, 'StylePreset'), Error, 'clusterVote');
});

Deno.test('cluster-vote with an empty palette refuses at runtime too', async () => {
  // Defence in depth: styleFromAovs takes a StylePreset object, so a caller
  // that skipped validation still must not produce a blank sprite reporting
  // success.
  const out = await Deno.makeTempDir();
  try {
    const bad = { ...PIXEL_8, id: 'blank-maker', quantize: undefined } as unknown as typeof PIXEL_8;
    const err = await assertRejects(() => styleFromAovs(SRC, CAM, bad, out), Error);
    assert(
      /clusterVote needs a palette/.test(err.message) && /blank/.test(err.message),
      `the refusal explains the blank sprite: ${err.message}`,
    );
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

/**
 * Write a minimal AOV frame set whose lit plane is a filled rect. `inset` 0
 * makes the silhouette reach the border; a positive inset leaves a margin.
 */
async function writeSyntheticAov(dir: string, sx: number, inset: number) {
  const rgba = new Uint8Array(sx * sx * 4);
  for (let y = inset; y < sx - inset; y++) {
    for (let x = inset; x < sx - inset; x++) {
      const i = (y * sx + x) * 4;
      rgba[i] = 180;
      rgba[i + 1] = 60;
      rgba[i + 2] = 60;
      rgba[i + 3] = 255;
    }
  }
  const gray = new Uint16Array(sx * sx).fill(1000);
  const write = async (pass: string, data: Uint8Array | Uint16Array, channels: number) => {
    await Deno.writeFile(
      `${dir}/d00_f000_${pass}.png`,
      encodePng({ width: sx, height: sx, data, channels, depth: channels === 1 ? 16 : 8 } as never),
    );
  };
  await write('lit', rgba, 4);
  await write('albedo', rgba, 4);
  await write('normal', rgba, 4);
  await write('depth', gray, 1);
  await write('mask', gray, 1);
}

Deno.test('silhouette-clipped fires when the character runs out of cell', async () => {
  // Nothing detected this before: camera.ts is explicit that the frustum never
  // depends on the model bounds, so a roster whose pixelsPerMeter x height
  // exceeds cellPx ships decapitated in every frame of every direction, and the
  // only signal was looking at the pixels. qaFlags had exactly one code.
  //
  // Synthetic AOVs, because the committed fixture was framed to fit and the
  // style stage cannot reframe it - it only downsamples what the renderer
  // already produced.
  const sx = 32; // superSample 4 -> an 8x8 cell
  const cut = await Deno.makeTempDir();
  const fits = await Deno.makeTempDir();
  try {
    await writeSyntheticAov(cut, sx, 0); // touches every border
    await writeSyntheticAov(fits, sx, 8); // a clear margin all round
    const src = (framesDir: string): AovSource => ({
      framesDir,
      directions: 1,
      frames: 1,
      width: sx,
      height: sx,
    });
    const cam = { ...CAM, cellPx: { w: sx / 4, h: sx / 4 } };

    const outCut = await Deno.makeTempDir();
    const outFits = await Deno.makeTempDir();
    try {
      const clipped = await styleFromAovs(src(cut), cam, PIXEL_8, outCut);
      const ok = await styleFromAovs(src(fits), cam, PIXEL_8, outFits);

      assertEquals(
        ok.flags.find((f) => f.code === 'silhouette-clipped'),
        undefined,
        'a character that fits raises no flag',
      );
      const fired = clipped.flags.find((f) => f.code === 'silhouette-clipped');
      assert(
        fired,
        `a cut-off character raises the flag; got ${
          JSON.stringify(clipped.flags.map((f) => f.code))
        }`,
      );
      assertEquals(fired!.severity, 'warn');
      assertEquals(fired!.sourceStage, 'look');
      assert(fired!.frameRefs.length > 0, 'and names the frames');
      // the message names WHICH edges — the diagnostic that turns "too tight"
      // into "a foot is below the baseline" or "the arm span outgrew the cell"
      assert(
        /top/.test(fired!.message) && /bottom/.test(fired!.message) &&
          /left/.test(fired!.message) && /right/.test(fired!.message),
        `a rect touching all four borders names all four: ${fired!.message}`,
      );
      assert(/padding budget is exhausted/.test(fired!.message), 'and says what it means');
    } finally {
      await Deno.remove(outCut, { recursive: true });
      await Deno.remove(outFits, { recursive: true });
    }
  } finally {
    await Deno.remove(cut, { recursive: true });
    await Deno.remove(fits, { recursive: true });
  }
});
