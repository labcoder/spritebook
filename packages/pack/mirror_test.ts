import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Mirroring (D-008), proved on both sides of the seam:
 *  - CPU: the plan follows the frozen rule, each pass flips the way its data
 *    demands (normals negate X), and the cache key can tell mirroring apart;
 *  - GPU (self-skipping, like integration_test.ts): a real bake of the
 *    ASYMMETRIC fixture — the mirrored direction's cells are exact flips of
 *    their source in all five passes, the manifest says which frames those are,
 *    only the rendered directions were styled, and an unmirrored bake marks
 *    nothing.
 *
 * The asymmetric fixture is deliberate: mirroring changes its pixels, so
 * "mirrored on == mirrored off" would be a false pass on a symmetric model.
 */
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { fileURLToPath } from 'node:url';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import type { BakeManifest, CameraPreset, JobEvent, RenderPass } from '@spritebook/schema';
import { BakeManifestSchema, parseWith, renderedDirections } from '@spritebook/schema';
import { PIXEL } from '@spritebook/style';
import { tryGetGpu } from '../render/dist/gpu.js';
import { type CellPlane, frameIdKey, PAGE_KIND } from './dist/contracts.js';
import { assertRenderedPrefix, flipCellPng, flipPlaneH, mirrorPlan } from './dist/mirror.js';
import { buildCacheInputs, runBakeJob } from './dist/bake.js';
import { predictInvalidation } from './dist/cache.js';
import { frameGrid } from './dist/manifest.js';

const GLB = fileURLToPath(new URL('../style/fixtures/asymmetric.glb', import.meta.url));
const CAM: CameraPreset = {
  id: 'mirror-30x4',
  elevationDeg: 30,
  directions: 4,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32,
  cellPx: { w: 64, h: 64 },
  paddingPx: 6,
  pivot: 'feet-baseline',
  orthographic: true,
};
const FRAMES = 2;
/** directions=4: 0 (front) and 2 (back) are self-symmetric, 3 mirrors 1. */
const MIRRORED_DIRECTION = 3;
const MIRROR_SOURCE = 1;

// ---------------------------------------------------------------------------
// CPU: the plan
// ---------------------------------------------------------------------------

test('mirror plan: off renders everything; on renders the front half only', () => {
  const off = mirrorPlan(8, false);
  assertEquals(off.rendered, [0, 1, 2, 3, 4, 5, 6, 7]);
  assertEquals(off.mirroredFrom.size, 0, 'D-008 default: nothing is mirrored');

  const on = mirrorPlan(8, true);
  assertEquals(on.rendered, renderedDirections(8, true), 'the plan is the frozen rule');
  assertEquals(on.rendered, [0, 1, 2, 3, 4]);
  assertEquals([...on.mirroredFrom].sort((a, b) => a[0] - b[0]), [[5, 3], [6, 2], [7, 1]]);
  assertRenderedPrefix(on); // style positions == direction indices

  // every direction is produced exactly once, by exactly one route
  for (const n of [2, 4, 8, 16]) {
    const plan = mirrorPlan(n, true);
    const produced = new Set([...plan.rendered, ...plan.mirroredFrom.keys()]);
    assertEquals(produced.size, n, `every direction of ${n} is accounted for`);
    for (const [d, src] of plan.mirroredFrom) {
      assert(plan.rendered.includes(src), `direction ${d} mirrors a RENDERED direction`);
      assert(!plan.mirroredFrom.has(src), 'a mirror never mirrors another mirror');
    }
  }
});

// ---------------------------------------------------------------------------
// CPU: the flips
// ---------------------------------------------------------------------------

/** A 3x2 rgba plane whose bytes encode their own (x, y) — flips are readable. */
function rgbaProbe(): CellPlane {
  const w = 3, h = 2;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = (y * w + x) * 4;
      rgba[at] = 10 + x; // R doubles as the normal's X channel
      rgba[at + 1] = 20 + y;
      rgba[at + 2] = 30 + x + y;
      rgba[at + 3] = 40 + x;
    }
  }
  return { w, h, rgba };
}

test('flip: color passes reverse columns and touch no channel', () => {
  const src = rgbaProbe();
  for (const pass of ['lit', 'albedo'] as RenderPass[]) {
    const out = flipPlaneH(src, pass);
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const from = (y * src.w + x) * 4;
        const to = (y * src.w + (src.w - 1 - x)) * 4;
        assertEquals(
          [...out.rgba!.slice(to, to + 4)],
          [...src.rgba!.slice(from, from + 4)],
          `${pass} pixel (${x},${y}) moved unchanged`,
        );
      }
    }
  }
});

test('flip: the normal pass negates X, or the mirrored half lights wrong', () => {
  const src = rgbaProbe();
  const out = flipPlaneH(src, 'normal');
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const from = (y * src.w + x) * 4;
      const to = (y * src.w + (src.w - 1 - x)) * 4;
      assertEquals(out.rgba![to], 255 - src.rgba![from], 'encoded X is negated');
      assertEquals(out.rgba![to + 1], src.rgba![from + 1], 'Y survives the mirror');
      assertEquals(out.rgba![to + 2], src.rgba![from + 2], 'Z survives the mirror');
      assertEquals(out.rgba![to + 3], src.rgba![from + 3], 'alpha is not a direction');
    }
  }
  // the mirror is its own inverse: flipping twice restores every byte
  const back = flipPlaneH(out, 'normal');
  assertEquals([...back.rgba!], [...src.rgba!], 'flip . flip == identity for normals');
});

test('flip: data passes reverse columns and never blend', () => {
  const w = 3, h = 2;
  const gray16 = Uint16Array.from([1, 2, 3, 4, 5, 6]);
  for (const pass of ['depth', 'mask'] as RenderPass[]) {
    const out = flipPlaneH({ w, h, gray16 }, pass);
    assertEquals([...out.gray16!], [3, 2, 1, 6, 5, 4], `${pass} is reversed, value for value`);
  }
});

test('flip: the encoded-PNG path agrees with the plane path, per pass', () => {
  const src = rgbaProbe();
  for (const pass of ['lit', 'albedo', 'normal'] as RenderPass[]) {
    const png = encodePng({ width: src.w, height: src.h, data: src.rgba! });
    const flipped = decodePng(flipCellPng(png, pass));
    assertEquals(
      [...(flipped.data as Uint8Array)],
      [...flipPlaneH(src, pass).rgba!],
      `${pass} survives the PNG round trip`,
    );
  }
  const gray = { w: 3, h: 2, gray16: Uint16Array.from([1, 2, 3, 4, 5, 6]) };
  const png = encodePng({ width: 3, height: 2, data: gray.gray16, channels: 1, depth: 16 });
  const flipped = decodePng(flipCellPng(png, 'depth'));
  assertEquals([...(flipped.data as Uint16Array)], [3, 2, 1, 6, 5, 4]);
});

test('flip: a mis-sized cell is refused, never silently half-copied', () => {
  let threw = false;
  try {
    flipPlaneH({ w: 4, h: 4, rgba: new Uint8Array(8) }, 'lit');
  } catch (err) {
    threw = true;
    assert(String(err).includes('rgba'), `names the problem: ${err}`);
  }
  assert(threw);
});

// ---------------------------------------------------------------------------
// CPU: cache honesty (D-011)
// ---------------------------------------------------------------------------

test('cache: mirroring is part of the recipe, so the two bakes never share', async () => {
  const base = {
    characterId: 'asym',
    modelPath: GLB,
    camera: CAM,
    style: PIXEL,
    frames: FRAMES,
  };
  const sig = 'test-render-sig@0';
  const off = await buildCacheInputs(base, sig);
  const on = await buildCacheInputs({ ...base, mirroring: true }, sig);
  assertNotEquals(
    off.cameraPresetHash,
    on.cameraPresetHash,
    'mirroring changes the pixels, so it must change the key',
  );
  assertEquals(
    predictInvalidation(off, on, frameGrid(CAM.directions, FRAMES)),
    frameGrid(CAM.directions, FRAMES),
    'flipping mirroring invalidates every frame',
  );
  // absent and explicit-false are the same recipe: no pre-D-008 cache churn
  const explicitOff = await buildCacheInputs({ ...base, mirroring: false }, sig);
  assertEquals(explicitOff, off, 'mirroring: false is byte-identical to the P2 recipe');
});

// ---------------------------------------------------------------------------
// GPU: the real bake
// ---------------------------------------------------------------------------

async function bake(
  outRoot: string,
  mirroring: boolean,
): Promise<{ manifest: BakeManifest; bakeDir: string; events: JobEvent[] }> {
  const events: JobEvent[] = [];
  for await (
    const e of runBakeJob({
      jobId: `mirror-${mirroring}`,
      characterId: 'asym',
      modelPath: GLB,
      camera: CAM,
      style: PIXEL,
      frames: FRAMES,
      outRoot,
      mirroring,
    })
  ) events.push(e);
  const err = events.find((e) => e.t === 'error');
  assert(!err, `bake failed: ${JSON.stringify(err)}`);
  const manifestPath =
    (events.find((e) => e.t === 'artifact' && e.kind === 'bake-manifest') as { path: string }).path;
  const bakeDir = manifestPath.slice(0, manifestPath.lastIndexOf('/'));
  return {
    manifest: parseWith(
      BakeManifestSchema,
      JSON.parse(await fs.readFile(manifestPath, 'utf8')),
      'BakeManifest',
    ),
    bakeDir,
    events,
  };
}

/** Lift one frame's cell out of its atlas page, as a plane of the pass's kind. */
async function cellOf(
  manifest: BakeManifest,
  bakeDir: string,
  pass: RenderPass,
  direction: number,
  frame: number,
): Promise<CellPlane> {
  const rec = manifest.frames.find((f) => f.direction === direction && f.frame === frame)!;
  const page = manifest.atlases.find((p) =>
    p.pass === pass && p.pageIndex === rec.atlas.pageIndex
  )!;
  const img = decodePng(new Uint8Array(await fs.readFile(`${bakeDir}/${page.png}`)));
  const { x, y, w, h } = rec.atlas;
  if (PAGE_KIND[pass] === 'rgba8') {
    const src = img.data as Uint8Array;
    const rgba = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      rgba.set(
        src.subarray(((y + row) * img.width + x) * 4, ((y + row) * img.width + x + w) * 4),
        row * w * 4,
      );
    }
    return { w, h, rgba };
  }
  const src = img.data as Uint16Array;
  const gray16 = new Uint16Array(w * h);
  for (let row = 0; row < h; row++) {
    gray16.set(src.subarray((y + row) * img.width + x, (y + row) * img.width + x + w), row * w);
  }
  return { w, h, gray16 };
}

test('acceptance: a mirrored bake flips every pass, marks it, and styles half', async (t) => {
  if (!(await tryGetGpu())) { t.skip('No WebGPU adapter'); return; }
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const on = await bake(`${root}/on`, true);
    const off = await bake(`${root}/off`, false);

    await t.test('the manifest names which frames are flips, and of what', () => {
      for (const f of on.manifest.frames) {
        if (f.direction === MIRRORED_DIRECTION) {
          assertEquals(
            f.mirroredFrom,
            { direction: MIRROR_SOURCE },
            `direction ${f.direction} is recorded as a mirror of ${MIRROR_SOURCE}`,
          );
        } else {
          assertEquals(f.mirroredFrom, undefined, `direction ${f.direction} was rendered`);
        }
      }
      assertEquals(
        on.manifest.frames.filter((f) => f.mirroredFrom).length,
        FRAMES,
        'exactly the mirrored direction x frames carry the mark',
      );
      // and the atlas keeps its shape: same frame set, same rects, either way
      assertEquals(
        on.manifest.frames.map((f) => frameIdKey(f)),
        off.manifest.frames.map((f) => frameIdKey(f)),
      );
      assertEquals(
        on.manifest.frames.map((f) => f.atlas),
        off.manifest.frames.map((f) => f.atlas),
        'mirrored cells enter the packer exactly like rendered ones',
      );
    });

    await t.test('mirroring OFF marks nothing (the D-008 default)', () => {
      assert(
        off.manifest.frames.every((f) => f.mirroredFrom === undefined),
        'an unmirrored bake claims no mirrors',
      );
      assert(
        !off.events.some((e) => e.t === 'warn' && e.code === 'mirroring-render-not-subset'),
        'and says nothing about mirroring',
      );
    });

    await t.test('only the rendered directions were styled', async () => {
      const styled = (dir: string) =>
        JSON.parse(readFileSync(`${dir}/style-result.json`, 'utf8')).directions;
      assertEquals(
        styled(on.bakeDir),
        renderedDirections(CAM.directions, true).length,
        'the style stage saw only the front half',
      );
      assertEquals(styled(off.bakeDir), CAM.directions, 'unmirrored styles every direction');
      await Promise.resolve();
    });

    await t.test('every pass of the mirrored direction is an exact flip', async () => {
      for (const pass of ['lit', 'albedo', 'normal', 'depth', 'mask'] as RenderPass[]) {
        for (let f = 0; f < FRAMES; f++) {
          const source = await cellOf(on.manifest, on.bakeDir, pass, MIRROR_SOURCE, f);
          const mirrored = await cellOf(on.manifest, on.bakeDir, pass, MIRRORED_DIRECTION, f);
          const expected = flipPlaneH(source, pass);
          if (PAGE_KIND[pass] === 'rgba8') {
            assertEquals([...mirrored.rgba!], [...expected.rgba!], `${pass} f${f} is the flip`);
          } else {
            assertEquals([...mirrored.gray16!], [...expected.gray16!], `${pass} f${f} is the flip`);
          }
        }
      }
    });

    await t.test('the normal page really did negate X (not just move pixels)', async () => {
      const source = await cellOf(on.manifest, on.bakeDir, 'normal', MIRROR_SOURCE, 0);
      const mirrored = await cellOf(on.manifest, on.bakeDir, 'normal', MIRRORED_DIRECTION, 0);
      const w = source.w;
      let compared = 0;
      for (let y = 0; y < source.h; y++) {
        for (let x = 0; x < w; x++) {
          const from = (y * w + x) * 4;
          const to = (y * w + (w - 1 - x)) * 4;
          if (source.rgba![from + 3] === 0) continue; // empty texel, nothing to check
          assertEquals(mirrored.rgba![to], 255 - source.rgba![from]);
          compared++;
        }
      }
      assert(compared > 50, `the sprite covers real texels (${compared} compared)`);
      // a pure pixel flip would leave X untouched somewhere off the n.x=0 line
      const bent = [...Array(source.h * w).keys()].some((p) => source.rgba![p * 4] !== 128);
      assert(bent, 'the fixture has normals off the mirror plane, so X negation is observable');
    });

    await t.test(
      'mirroring is not free for an asymmetric character (why it is opt-in)',
      async () => {
        const flipped = await cellOf(on.manifest, on.bakeDir, 'lit', MIRRORED_DIRECTION, 0);
        const rendered = await cellOf(off.manifest, off.bakeDir, 'lit', MIRRORED_DIRECTION, 0);
        assertNotEquals(
          [...flipped.rgba!],
          [...rendered.rgba!],
          'the one-armed fixture does not survive mirroring — D-008 in pixels',
        );
        assertNotEquals(
          on.manifest.bakeId,
          off.manifest.bakeId,
          'different output, different bake',
        );
      },
    );

    await t.test('the GPU really rendered only the non-flip directions', () => {
      // the saving is the POINT of mirroring, so prove it at the source: the
      // render seam wrote AOVs for the rendered subset and nothing else
      const plan = mirrorPlan(CAM.directions, true);
      assertEquals(
        plan.rendered.length,
        CAM.directions - plan.mirroredFrom.size,
        'the plan renders exactly the non-flip directions',
      );
      // and the manifest agrees: every non-rendered direction is a flip
      for (const f of on.manifest.frames) {
        const isFlip = f.mirroredFrom !== undefined;
        assertEquals(
          isFlip,
          !plan.rendered.includes(f.direction),
          `direction ${f.direction}: flip status matches the plan`,
        );
      }
    });

    await t.test('the bake says mirroring is on and what it means', () => {
      const warn = on.events.find((e) => e.t === 'warn' && e.code === 'mirroring-on');
      assert(warn, 'a mirrored bake warns that left/right differ at your peril');
    });
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
