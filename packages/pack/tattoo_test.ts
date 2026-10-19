import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * THE D-008 ACCEPTANCE (P3-T4): "the asymmetric character shows its tattoo on
 * the correct arm in all 8 directions."
 *
 * This is the founding constraint of the project stated as a test. A sprite
 * pipeline that mirrors by default is faster and, for anyone with a tattoo, a
 * prosthetic, an eyepatch or a shoulder pauldron, WRONG — and wrong in the
 * quiet way, where nothing errors and the character simply swaps handedness
 * halfway around the turntable.
 *
 * So the proof has two halves, and the second is the one that matters:
 *   1. with mirroring OFF (the default), the mark stays on the same side of
 *      the body through all 8 directions;
 *   2. with mirroring ON, it does NOT — which is exactly why it is opt-in.
 *
 * Asserting only (1) would pass on a build that had silently lost the feature;
 * asserting (2) proves the pipeline really can mirror and really was told not
 * to.
 */
import { assert, assertEquals } from '@std/assert';
import { decode as decodePng } from 'fast-png';
import type { BakeManifest, CameraPreset, JobEvent } from '@spritebook/schema';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import { PIXEL } from '@spritebook/style';
import { tryGetGpu } from '../render/dist/gpu.js';
import { runBakeJob } from './dist/mod.js';

/** The one-armed fixture: its mass sits on ONE side, which is the mark. */
const MODEL = new URL('../style/fixtures/asymmetric.glb', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

const CAM: CameraPreset = {
  id: 'tattoo-30x8',
  elevationDeg: 30,
  directions: 8,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32,
  cellPx: { w: 64, h: 64 },
  paddingPx: 6,
  pivot: 'feet-baseline',
  orthographic: true,
};

interface Baked {
  manifest: BakeManifest;
  bakeDir: string;
}

async function bake(outRoot: string, mirroring: boolean): Promise<Baked> {
  const events: JobEvent[] = [];
  for await (
    const e of runBakeJob({
      jobId: 'tattoo',
      characterId: 'one-armed',
      modelPath: MODEL,
      camera: CAM,
      style: PIXEL,
      frames: 1,
      outRoot,
      mirroring,
    })
  ) events.push(e);
  const err = events.find((e) => e.t === 'error');
  assert(!err, `bake failed: ${JSON.stringify(err)}`);
  const manifestPath = (events.find((e) => e.t === 'artifact' && e.kind === 'bake-manifest') as {
    path: string;
  }).path;
  return {
    manifest: parseWith(
      BakeManifestSchema,
      JSON.parse(await fs.readFile(manifestPath, 'utf8')),
      'BakeManifest',
    ),
    bakeDir: manifestPath.slice(0, manifestPath.lastIndexOf('/')),
  };
}

/** One frame's cell, copied out of its atlas page as RGBA. */
function cellOf(
  rgba: Uint8Array,
  stride: number,
  r: { x: number; y: number; w: number; h: number },
): Uint8Array {
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const src = ((r.y + y) * stride + (r.x + x)) * 4;
      const dst = (y * r.w + x) * 4;
      for (let c = 0; c < 4; c++) out[dst + c] = rgba[src + c];
    }
  }
  return out;
}

/** Horizontal mirror of a cell. */
function flipped(cell: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(cell.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = (y * w + (w - 1 - x)) * 4;
      for (let c = 0; c < 4; c++) out[dst + c] = cell[src + c];
    }
  }
  return out;
}

/** Fraction of pixels where two cells differ (any channel, tolerance 8/255). */
function differenceFraction(a: Uint8Array, b: Uint8Array): number {
  let diff = 0;
  const px = a.length / 4;
  for (let i = 0; i < px; i++) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs(a[i * 4 + c] - b[i * 4 + c]) > 8) {
        diff++;
        break;
      }
    }
  }
  return diff / px;
}

async function cells(b: Baked): Promise<Map<number, { data: Uint8Array; w: number; h: number }>> {
  const page = decodePng(new Uint8Array(await fs.readFile(`${b.bakeDir}/atlas_lit_0.png`)));
  const data = page.data as Uint8Array;
  const out = new Map<number, { data: Uint8Array; w: number; h: number }>();
  for (const f of b.manifest.frames) {
    out.set(f.direction, {
      data: cellOf(data, page.width, f.atlas),
      w: f.atlas.w,
      h: f.atlas.h,
    });
  }
  return out;
}

test('ACCEPTANCE: an asymmetric character keeps its side in all 8 directions', async (t) => {
  if (!(await tryGetGpu())) { t.skip('No WebGPU adapter'); return; }
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const off = await bake(`${root}/off`, false);
    assertEquals(off.manifest.frames.length, 8, 'all 8 directions baked');

    await t.test('mirroring is OFF by default and nothing is a flip', () => {
      for (const f of off.manifest.frames) {
        assertEquals(
          f.mirroredFrom,
          undefined,
          `direction ${f.direction} was RENDERED, not mirrored`,
        );
      }
    });

    await t.test('every direction is genuinely rendered, not a reflection', async () => {
      // The direct proof: if this character were bilaterally symmetric, the
      // horizontal flip of direction d would BE direction (8-d). For the
      // one-armed fixture it must not be — that difference IS the tattoo
      // staying on its own arm as the camera goes round.
      const c = await cells(off);
      for (const d of [1, 2, 3]) {
        const partner = 8 - d;
        const a = c.get(d)!;
        const b = c.get(partner)!;
        const frac = differenceFraction(flipped(a.data, a.w, a.h), b.data);
        assert(
          frac > 0.02,
          `d${partner} is ${(frac * 100).toFixed(1)}% different from mirrored d${d} - ` +
            `an asymmetric body must not read as its own mirror`,
        );
      }
    });

    await t.test('and mirroring ON would have faked it - which is why it is opt-in', async () => {
      const on = await bake(`${root}/on`, true);
      const mirrored = on.manifest.frames.filter((f) => f.mirroredFrom !== undefined);
      assertEquals(mirrored.length, 3, 'directions 5,6,7 came from flips');

      const c = await cells(on);
      for (const f of mirrored) {
        const source = f.mirroredFrom!.direction;
        const src = c.get(source)!;
        const got = c.get(f.direction)!;
        const frac = differenceFraction(flipped(src.data, src.w, src.h), got.data);
        assert(
          frac < 0.005,
          `mirrored d${f.direction} IS the flip of d${source} (${
            (frac * 100).toFixed(2)
          }% off) - ` +
            `which is exactly the lie D-008 refuses to tell by default`,
        );
      }

      assert(on.manifest.bakeId !== off.manifest.bakeId, 'different recipe, different bake');
    });
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
