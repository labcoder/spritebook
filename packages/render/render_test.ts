/**
 * Structural render tests (renderer-golden-testing skill): exact invariants, no
 * tolerance, no golden PNGs — dimensions, silhouette-in-padding, the pivot pixel,
 * the same-process double-render byte canary, and the width-100 strip. Perceptual
 * goldens arrive with the NPR presets in P2-T2 (on the dev GPU, a separate set).
 *
 * Every test is GPU-gated: hosted CI runners have no adapter and skip cleanly;
 * the lavapipe lane sets SPRITEBOOK_REQUIRE_GPU so a broken adapter fails loudly
 * instead of silently skipping. Shared-scale (two characters, one ruler) is a
 * pure property of the framing and is proven exhaustively in camera_test.ts.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { fileURLToPath } from 'node:url';
import { decode as decodePng } from 'fast-png';
import type { CameraPreset } from '@spritebook/schema';
import { tryGetGpu } from './gpu.ts';
import { AOV_TARGETS } from './contracts.ts';
import { loadSkinnedAsset, posedBounds } from './skinning.ts';
import { solveFraming } from './camera.ts';
import { Renderer } from './renderer.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/skinned-column.glb', import.meta.url));
const SHADERS = new URL('./shaders.wgsl', import.meta.url);

function preset(over: Partial<CameraPreset> = {}): CameraPreset {
  return {
    id: 'test-30x8',
    elevationDeg: 30,
    directions: 8,
    yawOffsetDeg: 0,
    pixelsPerMeter: 48,
    cellPx: { w: 128, h: 128 },
    paddingPx: 8,
    pivot: 'feet-baseline',
    orthographic: true,
    ...over,
  };
}

async function setup(over: Partial<CameraPreset> = {}) {
  const g = await tryGetGpu();
  if (!g) return null;
  const asset = await loadSkinnedAsset(FIXTURE);
  const cam = preset(over);
  // frame the posed bounds over the frames the tests touch (canary uses frame 5),
  // matching the production makeRenderer path (m6).
  const framing = solveFraming(cam, posedBounds(asset, 8));
  const shaderSrc = await Deno.readTextFile(SHADERS);
  const renderer = await Renderer.create(g, asset, framing, shaderSrc, cam.cellPx.w, cam.cellPx.h);
  return { asset, cam, framing, renderer };
}

/** alpha!=0 bounding box of an rgba8 plane. */
function alphaBBox(lit: Uint8Array, w: number, h: number) {
  let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (lit[(y * w + x) * 4 + 3] > 0) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY, count };
}

Deno.test('render: AOV pages are cellPx-sized, one per direction x frame x pass', async () => {
  const s = await setup();
  if (!s) return;
  const outDir = await Deno.makeTempDir();
  try {
    const { summary, throughputPath } = await s.renderer.renderAll(outDir, 2);
    assertEquals(summary.cellPx, { w: 128, h: 128 });
    assertEquals(summary.pageCount, 8 * 2 * AOV_TARGETS.length);
    const img = decodePng(await Deno.readFile(`${summary.framesDir}/d00_f000_lit.png`));
    assertEquals([img.width, img.height], [128, 128]);
    const tp = JSON.parse(await Deno.readTextFile(throughputPath));
    assert(tp.frames === 16 && tp.fps > 0, 'throughput report has real numbers');
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test('render: depth and mask AOVs encode drawn vs background correctly', async () => {
  // exercises the non-trivial png.ts paths: r32float->gray16 and r32uint->gray16
  const s = await setup({ pivot: 'center' });
  if (!s) return;
  const outDir = await Deno.makeTempDir();
  try {
    const { summary } = await s.renderer.renderAll(outDir, 1);
    const depth = decodePng(await Deno.readFile(`${summary.framesDir}/d00_f000_depth.png`));
    const mask = decodePng(await Deno.readFile(`${summary.framesDir}/d00_f000_mask.png`));
    const dd = depth.data as Uint16Array;
    const md = mask.data as Uint16Array;
    // corner (0,0) is background: depth cleared to far (1.0 -> 65535), mask empty (0)
    assertEquals(dd[0], 65535, 'depth background = far');
    assertEquals(md[0], 0, 'mask background = 0');
    // drawn texels exist: nearer depth (< far), and coverage at full scale.
    // This used to assert `v === 1`, which passed on a file every viewer
    // renders as solid black - the assertion agreed with the encoder and
    // neither of them agreed with anyone opening the png. Coverage is a
    // boolean, so the check is "not dark enough to pass for empty".
    assert(dd.some((v) => v < 65535), 'depth has drawn (nearer) texels');
    assert(md.some((v) => v === 65535), 'mask has covered texels, at full scale');
    assert(!md.some((v) => v !== 0 && v !== 65535), 'and coverage is only ever those two');
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test('render: pivot lands on the world-locked feet-baseline pixel', async () => {
  const s = await setup();
  if (!s) return;
  // feet-baseline ⇒ (w/2, h - paddingPx) = (64, 120)
  assertEquals(s.framing.pivotPx, { x: 64, y: 120 });
});

Deno.test('render: centered silhouette stays strictly inside the padding on all sides', async () => {
  // center pivot: the whole silhouette is framed around the cell centre, so the
  // strict all-sides alpha-in-padding invariant (atlas-bleed margins) holds.
  const s = await setup({ pivot: 'center' });
  if (!s) return;
  const [lit] = await s.renderer.capturePadded(0, 0);
  const { w, h } = s.cam.cellPx;
  const pad = s.cam.paddingPx;
  const bb = alphaBBox(lit, w, h);
  assert(bb.count > 0, 'silhouette is present');
  assert(
    bb.minX >= pad && bb.minY >= pad && bb.maxX <= w - pad && bb.maxY <= h - pad,
    `bbox [${bb.minX},${bb.minY},${bb.maxX},${bb.maxY}] must sit inside padding ${pad}`,
  );
});

Deno.test('render: feet-baseline grounds the feet at the baseline row', async () => {
  // feet-baseline pins the ground-contact row to h - paddingPx. Under an elevated
  // camera the footprint has visual depth, so the near foot projects a few px BELOW
  // the baseline into the bottom padding — that sub-baseline margin is the footprint
  // landing zone by design; the bleed margins that must stay clear are top/left/right.
  const s = await setup(); // feet-baseline (default)
  if (!s) return;
  const [lit] = await s.renderer.capturePadded(0, 0);
  const { w, h } = s.cam.cellPx;
  const pad = s.cam.paddingPx;
  const bb = alphaBBox(lit, w, h);
  const baseline = h - pad; // 120
  assert(bb.count > 0, 'silhouette is present');
  assert(bb.minX >= pad && bb.minY >= pad && bb.maxX <= w - pad, 'top/left/right respect padding');
  assert(bb.maxY < h, `silhouette stays within the cell (maxY=${bb.maxY})`);
  assert(
    bb.maxY >= baseline - 1 && bb.maxY - baseline <= pad,
    `feet grounded at baseline ${baseline}, footprint within bottom padding (maxY=${bb.maxY})`,
  );
});

Deno.test('render: same-process double render is byte-identical (nondeterminism canary)', async () => {
  const s = await setup();
  if (!s) return;
  const a = await s.renderer.capturePadded(2, 5);
  const b = await s.renderer.capturePadded(2, 5);
  for (let k = 0; k < a.length; k++) {
    assertEquals(a[k].length, b[k].length, `${AOV_TARGETS[k].pass} length`);
    assert(
      a[k].every((v, i) => v === b[k][i]),
      `${AOV_TARGETS[k].pass} AOV differs between renders`,
    );
  }
});

Deno.test('render: width-100 padded readback matches the per-row reference (strip test)', async () => {
  // row = 100*4 = 400 bytes -> padded to 512: exercises both the alignment and the strip
  const s = await setup({ cellPx: { w: 100, h: 128 } });
  if (!s) return;
  const padded = await s.renderer.capturePadded(0, 0);
  const rows = await s.renderer.captureRowByRow(0, 0);
  for (let k = 0; k < padded.length; k++) {
    assertEquals(padded[k].length, rows[k].length, `${AOV_TARGETS[k].pass} length`);
    assert(padded[k].every((v, i) => v === rows[k][i]), `${AOV_TARGETS[k].pass} AOV sheared`);
  }
});
