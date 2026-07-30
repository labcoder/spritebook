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
import { CEL_2, PAINTERLY, PIXEL, PRESETS } from './presets.ts';
import { srgbToHex } from '@spritebook/core';
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
  assertEquals(Object.keys(PRESETS).sort(), ['cel-2', 'clean', 'painterly', 'pixel']);
});

Deno.test('palette membership: every opaque pixel of a pixel style is a palette color', async () => {
  const out = await Deno.makeTempDir();
  try {
    const r = await styleFromAovs(SRC, CAM, PIXEL, out);
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
  // presets clear that with room. `pixel` earns the loosest of the three
  // because its stroke went to half a pixel: a 2-texel Sx stroke sits at the
  // cluster-vote margin, so an edge pixel can swing between outline and surface
  // with subpixel motion. That is the accepted price of an outline that no
  // longer swallows slim characters.
  // clean's 9% is a REGRESSION GUARD, not a quality bar: the any-byte-delta
  // metric reads continuous-tone output as ~animated coverage (fixture 4.39%
  // measured), so the guard exists to catch a broken texelSnap/hysteresis, and
  // perceived flicker needs the thresholded metric named for P4.
  const budget: Record<string, number> = {
    'pixel': 0.55,
    'cel-2': 0.15,
    'painterly': 1.0,
    'clean': 9.0,
  };
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
  // padding is 6; PIXEL outline width 0.5 -> no flag
  const clean = await Deno.makeTempDir();
  try {
    const r = await styleFromAovs(SRC, CAM, PIXEL, clean);
    assert(!r.flags.some((f) => f.code === 'outline-exceeds-padding'), 'no flag at width 1');
  } finally {
    await Deno.remove(clean, { recursive: true });
  }
  // width 8 > padding 6 -> flag with sourceStage 'look' + frameRefs
  const wide = await Deno.makeTempDir();
  try {
    const preset = { ...PIXEL, outline: { ...PIXEL.outline!, widthPx: 8 } };
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
  // pixel's maxColors. That passed while 25 of painterly's 32 entries were
  // duplicates of each other: it asserted the padding, not the palette. Entry
  // count was never the thing worth checking, because `nearestWithDist` breaks
  // ties with a strict `<`, so a duplicate entry can never be selected.
  const out = await Deno.makeTempDir();
  const out8 = await Deno.makeTempDir();
  try {
    const painterly = await styleFromAovs(SRC, CAM, PAINTERLY, out);
    const pixel = await styleFromAovs(SRC, CAM, PIXEL, out8);
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
      'pixel reports no duplicate palette entries',
    );

    // the larger budget can only ever help
    assert(
      painterly.paletteHex.length >= pixel.paletteHex.length,
      `painterly (${painterly.paletteHex.length}) must not be smaller than ` +
        `pixel (${pixel.paletteHex.length})`,
    );
    assert(
      painterly.paletteHex.length <= PAINTERLY.quantize!.maxColors,
      'and never exceeds its own budget',
    );
    // On THIS fixture both saturate: the lit AOV of a flat-shaded box holds
    // only a handful of distinct colours, so that count is the ceiling for any
    // maxColors above it. A palette larger than the source would be invented
    // colour.
    //
    // It was 8 when AMBIENT was 0.12 and is 5 at 0.30, which is the same
    // trade-off the rig change was made for, seen from the other side: shade is
    // `ambient + (1-ambient)*ndl`, so raising the floor narrows the range from
    // [0.12, 1.0] to [0.30, 1.0] and faces that used to quantize apart now
    // collapse together. On a flat-shaded box that is most of the colour it has.
    assertEquals(painterly.paletteHex.length, 5, "the fixture's own distinct-colour ceiling");
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
  const bad = { ...PIXEL, id: 'blank-maker', quantize: undefined };
  assertThrows(() => parseWith(StylePresetSchema, bad, 'StylePreset'), Error, 'clusterVote');
});

Deno.test('cluster-vote with an empty palette refuses at runtime too', async () => {
  // Defence in depth: styleFromAovs takes a StylePreset object, so a caller
  // that skipped validation still must not produce a blank sprite reporting
  // success.
  const out = await Deno.makeTempDir();
  try {
    const bad = { ...PIXEL, id: 'blank-maker', quantize: undefined } as unknown as typeof PIXEL;
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
interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

async function writeSyntheticAov(dir: string, sx: number, inset: number | Insets) {
  const ins: Insets = typeof inset === 'number'
    ? { top: inset, bottom: inset, left: inset, right: inset }
    : inset;
  const rgba = new Uint8Array(sx * sx * 4);
  for (let y = ins.top; y < sx - ins.bottom; y++) {
    for (let x = ins.left; x < sx - ins.right; x++) {
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
      const clipped = await styleFromAovs(src(cut), cam, PIXEL, outCut);
      const ok = await styleFromAovs(src(fits), cam, PIXEL, outFits);

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

Deno.test('the bottom edge is a grounding fault, and is not blamed on the camera', async () => {
  // The P3 exit measurement hit this on all 48 frames and the flag sent the
  // user to pixelsPerMeter. It was grounding: rigging had discarded the
  // border's placement and left the body centred on the origin, 16 px of it
  // below the pivot row at 32 px/m. Shrinking the camera would have stopped the
  // clipping by making a half-buried character smaller.
  //
  // camera.ts pins world Y=0 to `cellPx.h - paddingPx` for a feet-baseline
  // preset and the model bounds never enter that solve, so silhouette below the
  // pivot row IS geometry under the floor. That inference is what the flag owes
  // the user.
  const sx = 32;
  const below = await Deno.makeTempDir();
  const wide = await Deno.makeTempDir();
  try {
    await writeSyntheticAov(below, sx, { top: 8, bottom: 0, left: 8, right: 8 });
    await writeSyntheticAov(wide, sx, { top: 8, bottom: 8, left: 0, right: 0 });
    const src = (framesDir: string): AovSource => ({
      framesDir,
      directions: 1,
      frames: 1,
      width: sx,
      height: sx,
    });
    const cam = { ...CAM, cellPx: { w: sx / 4, h: sx / 4 } };

    const outB = await Deno.makeTempDir();
    const outW = await Deno.makeTempDir();
    try {
      const b = (await styleFromAovs(src(below), cam, PIXEL, outB)).flags
        .find((f) => f.code === 'silhouette-clipped');
      assert(b, 'a body below the baseline still raises the flag');
      assert(/rig --feet-ground/.test(b!.message), `it names the knob: ${b!.message}`);
      assert(
        /standing IN the floor/.test(b!.message),
        `and says what is actually wrong: ${b!.message}`,
      );
      assert(
        !/lower pixelsPerMeter or raise cellPx/.test(b!.message),
        `and does NOT send the user to the camera: ${b!.message}`,
      );

      // the other half: a genuine overflow keeps the camera advice, because
      // there it is the right answer
      const w = (await styleFromAovs(src(wide), cam, PIXEL, outW)).flags
        .find((f) => f.code === 'silhouette-clipped');
      assert(w, 'an over-wide character raises the flag');
      assert(
        /lower pixelsPerMeter or raise cellPx/.test(w!.message),
        `left/right IS a framing problem: ${w!.message}`,
      );
      assert(!/feet-ground/.test(w!.message), `and grounding is not mentioned: ${w!.message}`);
    } finally {
      await Deno.remove(outB, { recursive: true });
      await Deno.remove(outW, { recursive: true });
    }
  } finally {
    await Deno.remove(below, { recursive: true });
    await Deno.remove(wide, { recursive: true });
  }
});

Deno.test('bottom clipping on a CENTER pivot is framing, because Y=0 is not pinned', async () => {
  // The grounding inference is only available on feet-baseline: a center pivot
  // puts the bounding-box middle on the middle row and world Y=0 lands wherever
  // the body's height puts it, so "below the pivot" says nothing about the floor.
  const sx = 32;
  const dir = await Deno.makeTempDir();
  const out = await Deno.makeTempDir();
  try {
    await writeSyntheticAov(dir, sx, { top: 8, bottom: 0, left: 8, right: 8 });
    const cam = { ...CAM, cellPx: { w: sx / 4, h: sx / 4 }, pivot: 'center' as const };
    const f = (await styleFromAovs(
      { framesDir: dir, directions: 1, frames: 1, width: sx, height: sx },
      cam,
      PIXEL,
      out,
    )).flags.find((fl) => fl.code === 'silhouette-clipped');
    assert(f, 'still flagged');
    assert(!/feet-ground/.test(f!.message), `no grounding claim it cannot support: ${f!.message}`);
    assert(/lower pixelsPerMeter or raise cellPx/.test(f!.message), f!.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(out, { recursive: true });
  }
});
