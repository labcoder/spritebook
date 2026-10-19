import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * THE TRACK A ACCEPTANCE (body-task close-out): the full roster path in one
 * test — canonical body, fitted, decaled on ONE forearm, baked in 8
 * directions — with the D-008 proof measured as an A/B against the SAME bake
 * of the undecaled body:
 *
 *   changed(d) = pixels of direction d that the decal changed (plain vs
 *                decaled cell, same direction, so geometry/lighting cancel)
 *
 *   1. the decal is VISIBLE wherever the arm is: at least 6 of 8 directions
 *      carry it clearly. Not all 8 — from the pure opposite profile the far
 *      arm ducks behind the torso (ubc-male at this camera: 1 px from dir 6),
 *      and that occlusion is CORRECT rendering, not a lost decal;
 *   2. it did NOT mirror: flip(changed(d)) barely overlaps changed(8-d) —
 *      a MIRRORED mark coincides with itself under the flip, a one-armed
 *      mark cannot. This is the D-008 claim itself.
 *
 * The A/B matters because "has magenta pixels" would break the moment the
 * palette quantized magenta to something else, and a raw mirror-symmetry
 * score of the decaled bake alone drowns in the body's own asymmetry (hair,
 * pose, texture detail). Diffing per-direction against the plain bake
 * isolates exactly the thing the tattoo added, in the pixels a game ships.
 *
 * The footprints are measured on the ALBEDO atlas pages (shipped alongside
 * lit in every bake): every preset's palette is ADAPTIVE and built per bake,
 * so the ink repaints the whole LIT sprite between the two bakes — measured
 * on lit, that crosstalk outweighed the tattoo ~10:1 on both sides. Albedo
 * is area-averaged and never quantized, so its diff is the decal and nothing
 * else. The camera is denser than the roster default (40 px/m, 96px cells)
 * because at 24 px/m a forearm is ~4 px wide; the 48/255 mask tolerance
 * keeps soft area-average edge blends out of the footprint.
 */
import { assert, assertEquals } from '@std/assert';
import { decode as decodePng } from 'fast-png';
import type { BakeManifest, CameraPreset, JobEvent } from '@spritebook/schema';
import { BakeManifestSchema, CanonicalBodySchema, parseWith } from '@spritebook/schema';
import { PAINTERLY } from '@spritebook/style';
import { encode as encodePng } from 'fast-png';
import { compositeDecals } from '../gen/dist/identity.js';
import { fitCanonicalBody } from '../rig/dist/fit.js';
import { tryGetGpu } from '../render/dist/gpu.js';
import { runBakeJob } from './dist/mod.js';

const win = (u: URL) => decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BODY_DIR = win(new URL('../rig/bodies/ubc-male', import.meta.url));
const TARGET = win(new URL('../anim/fixtures/humanoid-tall-thin.glb', import.meta.url));

const CAM: CameraPreset = {
  id: 'tracka-30x8',
  elevationDeg: 30,
  directions: 8,
  yawOffsetDeg: 0,
  pixelsPerMeter: 40,
  cellPx: { w: 96, h: 96 },
  paddingPx: 8,
  pivot: 'feet-baseline',
  orthographic: true,
};

async function bake(modelPath: string, outRoot: string, characterId: string) {
  const events: JobEvent[] = [];
  for await (
    const e of runBakeJob({
      jobId: 'tracka',
      characterId,
      modelPath,
      camera: CAM,
      style: PAINTERLY,
      frames: 1,
      outRoot,
    })
  ) events.push(e);
  const err = events.find((e) => e.t === 'error');
  assert(!err, `bake failed: ${JSON.stringify(err)}`);
  const manifestPath = (events.find((e) => e.t === 'artifact' && e.kind === 'bake-manifest') as {
    path: string;
  }).path;
  const manifest = parseWith(
    BakeManifestSchema,
    JSON.parse(await fs.readFile(manifestPath, 'utf8')),
    'BakeManifest',
  );
  return { manifest, bakeDir: manifestPath.slice(0, manifestPath.lastIndexOf('/')) };
}

function cellOf(
  rgba: Uint8Array,
  stride: number,
  r: { x: number; y: number; w: number; h: number },
) {
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const src = ((r.y + y) * stride + (r.x + x)) * 4;
      out.set(rgba.subarray(src, src + 4), (y * r.w + x) * 4);
    }
  }
  return out;
}

/** 1 per pixel where any channel differs by more than 48 (palette drift stays under). */
function changedMask(a: Uint8Array, b: Uint8Array) {
  const px = a.length / 4;
  const mask = new Uint8Array(px);
  for (let i = 0; i < px; i++) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs(a[i * 4 + c] - b[i * 4 + c]) > 48) {
        mask[i] = 1;
        break;
      }
    }
  }
  return mask;
}

const count = (m: Uint8Array) => m.reduce((s, v) => s + v, 0);

/** How many of a's set pixels land on set pixels of b after flipping a horizontally. */
function flippedOverlap(a: Uint8Array, b: Uint8Array, w: number, h: number) {
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a[y * w + x] && b[y * w + (w - 1 - x)]) n++;
    }
  }
  return n;
}

/**
 * The per-direction decal footprints: changed(d) = plain cell(d) vs decaled
 * cell(d), on the ALBEDO atlas. Albedo is area-averaged, never
 * palette-quantized (aov1x.ts) — the adaptive palette repaints the whole LIT
 * sprite between the two bakes (the ink shifts the palette globally), so lit
 * diffs carry body-wide crosstalk; albedo diffs are the decal and nothing else.
 */
async function decalFootprints(
  plain: { manifest: BakeManifest; bakeDir: string },
  marked: { manifest: BakeManifest; bakeDir: string },
) {
  const pageP = decodePng(new Uint8Array(await fs.readFile(`${plain.bakeDir}/atlas_albedo_0.png`)));
  const pageM = decodePng(new Uint8Array(await fs.readFile(`${marked.bakeDir}/atlas_albedo_0.png`)));
  const byDirP = new Map(plain.manifest.frames.map((f) => [f.direction, f.atlas]));
  const byDirM = new Map(marked.manifest.frames.map((f) => [f.direction, f.atlas]));
  const masks = new Map<number, { mask: Uint8Array; w: number; h: number }>();
  for (const [d, rP] of byDirP) {
    const rM = byDirM.get(d)!;
    assertEquals({ w: rP.w, h: rP.h }, { w: rM.w, h: rM.h }, `direction ${d} cell sizes match`);
    masks.set(d, {
      mask: changedMask(
        cellOf(pageP.data as Uint8Array, pageP.width, rP),
        cellOf(pageM.data as Uint8Array, pageM.width, rM),
      ),
      w: rP.w,
      h: rP.h,
    });
  }
  return masks;
}

test('ACCEPTANCE: fit -> decal -> bake, and the tattoo stays on its own arm', async (t) => {
  if (!(await tryGetGpu())) { t.skip('No WebGPU adapter'); return; }
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    // 1. the real Track A front half: bundled body fitted to a fixture target
    const fitted = `${root}/fitted.glb`;
    const fit = await fitCanonicalBody({
      bodyPath: `${BODY_DIR}/body.glb`,
      bodyManifestPath: `${BODY_DIR}/body.json`,
      targetPath: TARGET,
      outPath: fitted,
    });
    assertEquals(fit.strayJoints, [], 'the bundled body fits the fixture cleanly');

    // 2. one loud decal on the LEFT forearm region, opt-in mirroring OFF
    const body = parseWith(
      CanonicalBodySchema,
      JSON.parse(await fs.readFile(`${BODY_DIR}/body.json`, 'utf8')),
      'ubc-male body.json',
    );
    const region = body.regions.find((r) => r.side === 'left' && r.id.includes('arm'));
    assert(region, `the body declares a left arm region (have: ${body.regions.map((r) => r.id)})`);
    const decalPng = `${root}/tattoo.png`;
    const ink = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < 256; i++) ink.set([255, 0, 255, 255], i * 4);
    await fs.writeFile(decalPng, encodePng({ width: 16, height: 16, data: ink }));
    const decaled = `${root}/decaled.glb`;
    const report = await compositeDecals({
      modelPath: fitted,
      decals: [{ id: 'tattoo', pngPath: decalPng, region: region.id, z: 0, mirrored: false }],
      body,
      outPath: decaled,
    });
    assert(report.changedTexels > 0, 'the tattoo painted real texels');
    assertEquals(report.missed, [], 'nothing silently missed');

    // 3. bake BOTH and diff per direction: where did the tattoo land?
    const plain = await bake(fitted, `${root}/plain`, 'tracka-plain');
    const marked = await bake(decaled, `${root}/marked`, 'tracka-marked');
    const masks = await decalFootprints(plain, marked);
    const px = (ds: number[]) => ds.reduce((s, d) => s + count(masks.get(d)!.mask), 0);

    await t.test('the tattoo shows wherever the arm is on screen (>= 6 of 8 dirs)', () => {
      const counts = [...masks.entries()].map(([d, m]) => [d, count(m.mask)] as const);
      const clear = counts.filter(([, n]) => n >= 5);
      assert(
        clear.length >= 6,
        `the tattoo is clearly visible from ${clear.length}/8 directions ` +
          `(${counts.map(([d, n]) => `d${d}:${n}px`).join(' ')}) - occlusion may hide the far ` +
          'arm from the opposite profile, but not from most of the ring',
      );
      const total = px([...masks.keys()]);
      assert(total >= 60, `the tattoo changed ${total} px across 8 directions - expected >= 60`);
    });

    await t.test('and did NOT mirror onto the other arm (D-008)', () => {
      for (const d of [1, 2, 3]) {
        const a = masks.get(d)!;
        const b = masks.get(8 - d)!;
        const overlap = flippedOverlap(a.mask, b.mask, a.w, a.h);
        const bigger = Math.max(count(a.mask), count(b.mask), 1);
        assert(
          overlap <= 0.25 * bigger,
          `dirs ${d}/${8 - d}: flipped overlap ${overlap} vs footprint ${bigger} - ` +
            `a mirrored tattoo would coincide with itself`,
        );
      }
    });

    await t.test('and every direction was rendered, none mirrored (D-008 default)', () => {
      for (const f of marked.manifest.frames) assertEquals(f.mirroredFrom, undefined);
    });
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
