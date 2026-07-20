/**
 * The pooled-palette LAW, discriminated (review F10): a per-clip-palette
 * implementation of styleClipsFromAovs would pass a shape-only check, so this
 * test builds a second clip with rotated hues and asserts the pooling is
 * OBSERVABLE — clip A styled jointly with B differs from A styled alone, and
 * every opaque pixel of BOTH clips lands in the ONE reported palette.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import type { CameraPreset } from '@spritebook/schema';
import { styleClipsFromAovs, styleFromAovs } from './pipeline.ts';
import { PIXEL_8 } from './presets.ts';
import { srgbToHex } from './oklab.ts';
import { aovFileName } from './contracts.ts';
import type { ClipAovSource } from './pipeline.ts';

const FRAMES = new URL('./fixtures/aov/frames/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
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
const DIRS = 2;
const FRAME_N = 2; // subset of the committed 6 — enough signal, fast
const PASSES = ['lit', 'albedo', 'normal', 'depth', 'mask'];

/** Clip B = the committed AOVs with lit hues rotated (r,g,b) -> (b,r,g). */
async function makeRotatedClip(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  for (let d = 0; d < DIRS; d++) {
    for (let f = 0; f < FRAME_N; f++) {
      for (const pass of PASSES) {
        const name = aovFileName(d, f, pass);
        const bytes = await Deno.readFile(`${FRAMES}/${name}`);
        if (pass !== 'lit') {
          await Deno.writeFile(`${dir}/${name}`, bytes);
          continue;
        }
        const img = decodePng(bytes);
        const px = img.data as Uint8Array;
        for (let p = 0; p < img.width * img.height; p++) {
          const r = px[p * 4], g = px[p * 4 + 1], b = px[p * 4 + 2];
          px[p * 4] = b;
          px[p * 4 + 1] = r;
          px[p * 4 + 2] = g;
        }
        await Deno.writeFile(
          `${dir}/${name}`,
          encodePng({ width: img.width, height: img.height, data: px }),
        );
      }
    }
  }
}

function opaqueHexes(img: { width: number; height: number; data: Uint8Array }): Set<string> {
  const out = new Set<string>();
  for (let p = 0; p < img.width * img.height; p++) {
    if (img.data[p * 4 + 3] === 0) continue;
    out.add(srgbToHex(img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]));
  }
  return out;
}

Deno.test('styleClipsFromAovs pools ONE palette across clips (observable)', async () => {
  const root = await Deno.makeTempDir();
  try {
    const bDir = `${root}/clip-b-frames`;
    await makeRotatedClip(bDir);
    const size = { width: 256, height: 256 };
    const a: ClipAovSource = {
      clipId: 'a',
      framesDir: FRAMES,
      directions: DIRS,
      frames: FRAME_N,
      ...size,
    };
    const bSrc: ClipAovSource = {
      clipId: 'b',
      framesDir: bDir,
      directions: DIRS,
      frames: FRAME_N,
      ...size,
    };

    const jointOut = `${root}/joint`;
    const joint = await styleClipsFromAovs([a, bSrc], CAM, PIXEL_8, jointOut);

    // honest multi-clip accounting (review F8)
    assertEquals(joint.frames, FRAME_N * 2, 'frames = per-direction total across clips');

    // one palette governs BOTH clips' pixels
    const palette = new Set(joint.paletteHex);
    for (const clipId of ['a', 'b']) {
      const img = decodePng(
        await Deno.readFile(`${joint.styledDir}/${clipId}/d00_f000.png`),
      );
      for (const hex of opaqueHexes(img as never)) {
        assert(palette.has(hex), `clip ${clipId} opaque pixel ${hex} outside the pooled palette`);
      }
    }

    // the discriminator: clip A styled JOINTLY differs from clip A styled ALONE
    // (clip B's hues moved the shared palette). A per-clip-palette
    // implementation would produce byte-identical output here.
    const soloOut = `${root}/solo`;
    const solo = await styleFromAovs(
      { framesDir: FRAMES, directions: DIRS, frames: FRAME_N, ...size },
      CAM,
      PIXEL_8,
      soloOut,
    );
    const aJoint = await Deno.readFile(`${joint.styledDir}/a/d00_f000.png`);
    const aSolo = await Deno.readFile(`${solo.styledDir}/d00_f000.png`);
    assert(
      aJoint.length !== aSolo.length || !aJoint.every((v, i) => v === aSolo[i]),
      'joint styling must differ from solo styling when another clip changes the pool',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('styleClipsFromAovs is deterministic across runs', async () => {
  const root = await Deno.makeTempDir();
  try {
    const src: ClipAovSource = {
      clipId: 'a',
      framesDir: FRAMES,
      directions: DIRS,
      frames: FRAME_N,
      width: 256,
      height: 256,
    };
    const r1 = await styleClipsFromAovs([src], CAM, PIXEL_8, `${root}/one`);
    const r2 = await styleClipsFromAovs([src], CAM, PIXEL_8, `${root}/two`);
    assertEquals(r1.paletteHex, r2.paletteHex);
    assertEquals(
      await Deno.readFile(`${r1.styledDir}/a/d00_f000.png`),
      await Deno.readFile(`${r2.styledDir}/a/d00_f000.png`),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
