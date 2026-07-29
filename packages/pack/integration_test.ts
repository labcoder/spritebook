/**
 * P2-T3 acceptance, end-to-end on a real bake of the asymmetric fixture
 * (GPU-gated; SPRITEBOOK_REQUIRE_GPU forces it on the lavapipe lane):
 *  1. rect-identity across passes — every pass has a page per index at one
 *     size, and the mask page has sprite content exactly inside the lit rects;
 *  2. unchanged-bake byte-stability — two independent bakes agree on bakeId,
 *     pages, style-result, and all four exporter outputs byte-for-byte;
 *  3. predicted-vs-actual invalidation — unchanged -> zero misses (100% hits),
 *     an outline-width change -> exactly the predicted (all) frames miss;
 *  4. pivot anti-drift — pack's pivotFor matches the render framing solver's
 *     real render-summary.json.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { decode as decodePng } from 'fast-png';
import type { BakeManifest, CameraPreset, JobEvent, StylePreset } from '@spritebook/schema';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import { PIXEL } from '@spritebook/style';
import { renderSignature, runRenderJob } from '@spritebook/render';
import { tryGetGpu } from '../render/gpu.ts';
import { exportGodot, parseTres, runExportJob, validateTres } from '@spritebook/export';
import { buildCacheInputs, frameGrid, pivotFor, predictInvalidation, runBakeJob } from './mod.ts';

const GLB = new URL('../style/fixtures/asymmetric.glb', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const CAM: CameraPreset = {
  id: 'itest-30x2',
  elevationDeg: 30,
  directions: 2,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32,
  cellPx: { w: 64, h: 64 },
  paddingPx: 6,
  pivot: 'feet-baseline',
  orthographic: true,
};
const FRAMES = 2;

async function bake(
  outRoot: string,
  over: { style?: StylePreset; cacheDir?: string; onlyInvalidated?: boolean } = {},
): Promise<{ manifest: BakeManifest; bakeDir: string; events: JobEvent[] }> {
  const events: JobEvent[] = [];
  for await (
    const e of runBakeJob({
      jobId: 'itest',
      characterId: 'asym',
      modelPath: GLB,
      camera: CAM,
      style: over.style ?? PIXEL,
      frames: FRAMES,
      outRoot,
      cacheDir: over.cacheDir,
      onlyInvalidated: over.onlyInvalidated,
    })
  ) events.push(e);
  const err = events.find((e) => e.t === 'error');
  assert(!err, `bake failed: ${JSON.stringify(err)}`);
  const manifestPath = (events.find((e) => e.t === 'artifact' && e.kind === 'bake-manifest') as
    | { path: string }
    | undefined)?.path!;
  const bakeDir = manifestPath.slice(0, manifestPath.lastIndexOf('/'));
  const manifest = parseWith(
    BakeManifestSchema,
    JSON.parse(await Deno.readTextFile(manifestPath)),
    'BakeManifest',
  );
  return { manifest, bakeDir, events };
}

Deno.test('acceptance: bake -> rect identity, stability, invalidation, pivot, exporters', async (t) => {
  if (!(await tryGetGpu())) return;
  const root = await Deno.makeTempDir();
  try {
    const a = await bake(`${root}/a`);

    await t.step(
      'rect identity: 5 passes x pages at one size; mask content inside rects',
      async () => {
        const byPass = new Map<string, number>();
        for (const p of a.manifest.atlases) {
          byPass.set(p.pass, (byPass.get(p.pass) ?? 0) + 1);
          assertEquals(p.sizePx, a.manifest.atlases[0].sizePx, 'uniform page size');
          assertEquals(p.layoutSharedWith, 'lit');
        }
        assertEquals([...byPass.values()], [1, 1, 1, 1, 1], 'one page per pass for this bake');

        const lit = decodePng(await Deno.readFile(`${a.bakeDir}/atlas_lit_0.png`));
        const mask = decodePng(await Deno.readFile(`${a.bakeDir}/atlas_mask_0.png`));
        assertEquals([lit.width, lit.height], [mask.width, mask.height]);
        const litData = lit.data as Uint8Array;
        const maskData = mask.data as Uint16Array;
        for (const f of a.manifest.frames) {
          let litIn = 0, maskIn = 0;
          for (let y = f.atlas.y; y < f.atlas.y + f.atlas.h; y++) {
            for (let x = f.atlas.x; x < f.atlas.x + f.atlas.w; x++) {
              if (litData[(y * lit.width + x) * 4 + 3] > 0) litIn++;
              if (maskData[y * mask.width + x] > 0) maskIn++;
            }
          }
          assert(litIn > 50 && maskIn > 50, `sprite present in both passes at rect ${f.frame}`);
        }
      },
    );

    await t.step('byte-stability: independent rebake agrees everywhere it must', async () => {
      const b = await bake(`${root}/b`);
      assertEquals(a.manifest.bakeId, b.manifest.bakeId, 'same recipe -> same bakeId');
      // manifests equal after removing the volatile fields
      const strip = (m: BakeManifest) => ({
        ...m,
        createdAt: '',
        metrics: { ...m.metrics, wallTimeS: 0 },
      });
      assertEquals(strip(a.manifest), strip(b.manifest));
      for (const page of a.manifest.atlases) {
        assertEquals(
          await Deno.readFile(`${a.bakeDir}/${page.png}`),
          await Deno.readFile(`${b.bakeDir}/${page.png}`),
          `page differs: ${page.png}`,
        );
      }
      assertEquals(
        await Deno.readTextFile(`${a.bakeDir}/style-result.json`),
        await Deno.readTextFile(`${b.bakeDir}/style-result.json`),
      );
      // and the exporters project both bakes to byte-identical trees
      for (const target of ['godot', 'aseprite', 'texturepacker', 'strips'] as const) {
        const [ea, eb] = [`${root}/exp-a`, `${root}/exp-b`];
        for await (
          const _ of runExportJob({ jobId: 'x', bakeDir: a.bakeDir, outDir: ea, targets: [target] })
        ) { /* drain */ }
        for await (
          const _ of runExportJob({ jobId: 'x', bakeDir: b.bakeDir, outDir: eb, targets: [target] })
        ) { /* drain */ }
        for await (const f of Deno.readDir(`${ea}/${target}`)) {
          assertEquals(
            await Deno.readFile(`${ea}/${target}/${f.name}`),
            await Deno.readFile(`${eb}/${target}/${f.name}`),
            `${target}/${f.name} differs across bakes`,
          );
        }
      }
    });

    await t.step(
      'invalidation: unchanged -> zero misses; outline change -> exactly all',
      async () => {
        const cacheDir = `${root}/cache`;
        const grid = frameGrid(CAM.directions, FRAMES);
        const cold = await bake(`${root}/c1`, { cacheDir, onlyInvalidated: true });
        assertEquals(cold.manifest.metrics.cacheHitPct, 0, 'cold cache misses everything');

        const sig = await renderSignature();
        const inputs = await buildCacheInputs({
          characterId: 'asym',
          modelPath: GLB,
          camera: CAM,
          style: PIXEL,
          frames: FRAMES,
        }, sig);
        assertEquals(
          predictInvalidation(inputs, inputs, grid),
          [],
          'prediction: unchanged -> none',
        );
        const warm = await bake(`${root}/c2`, { cacheDir, onlyInvalidated: true });
        assertEquals(warm.manifest.metrics.cacheHitPct, 100, 'actual: unchanged -> all hits');
        assert(warm.manifest.frames.every((f) => f.cacheHit), 'every frame served from cache');
        // the served bake reproduces the recomputed pages byte-for-byte
        assertEquals(
          await Deno.readFile(`${cold.bakeDir}/atlas_lit_0.png`),
          await Deno.readFile(`${warm.bakeDir}/atlas_lit_0.png`),
        );

        const wider: StylePreset = {
          ...PIXEL,
          outline: { ...PIXEL.outline!, widthPx: 2 },
        };
        const newInputs = await buildCacheInputs({
          characterId: 'asym',
          modelPath: GLB,
          camera: CAM,
          style: wider,
          frames: FRAMES,
        }, sig);
        const predicted = predictInvalidation(inputs, newInputs, grid);
        assertEquals(predicted, grid, 'prediction: look change -> every frame');
        const changed = await bake(`${root}/c3`, {
          style: wider,
          cacheDir,
          onlyInvalidated: true,
        });
        assertEquals(
          changed.manifest.metrics.cacheHitPct,
          0,
          'actual: exactly the predicted set missed',
        );
        assert(changed.manifest.frames.every((f) => !f.cacheHit));
        assert(changed.manifest.bakeId !== warm.manifest.bakeId, 'new recipe, new bake identity');
      },
    );

    await t.step('pivot anti-drift: pivotFor matches the render framing solver', async () => {
      const renderOut = await Deno.makeTempDir();
      try {
        for await (
          const e of runRenderJob({
            jobId: 'pv',
            modelPath: GLB,
            camera: CAM,
            frames: 1,
            pose: 'idle',
            stylePreset: '',
            outDir: renderOut,
          })
        ) {
          assert(e.t !== 'error', `render failed: ${JSON.stringify(e)}`);
        }
        const summary = JSON.parse(await Deno.readTextFile(`${renderOut}/render-summary.json`));
        assertEquals(pivotFor(CAM), summary.pivotPx, 'pack pivot == render pivot');
        assertEquals(a.manifest.frames[0].pivotPx, summary.pivotPx);
      } finally {
        await Deno.remove(renderOut, { recursive: true });
      }
    });

    await t.step('the real bake exports a valid, manifest-consistent .tres', async () => {
      const out = `${root}/godot-real`;
      await exportGodot(a.manifest, a.bakeDir, out, { fps: 8 });
      const parsed = parseTres(await Deno.readTextFile(`${out}/asym.tres`));
      validateTres(parsed, a.manifest); // throws on any inconsistency
      assertEquals(parsed.animations.length, CAM.directions);
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
