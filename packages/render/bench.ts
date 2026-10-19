import { promises as fs } from 'node:fs';
/**
 * Throughput probe: render the checked-in fixture through the seam and leave
 * throughput.json (frames/sec, readback MB/s) under `outDir` for CI to upload on
 * every run, so render-throughput regressions are visible in the trend (P2-T1
 * acceptance). NOT a pass/fail gate — software Vulkan on CI is slow by design and
 * numbers are machine-dependent; this is a trend signal, never hashed for cache.
 *
 *   node tools/run.mjs \
 *     packages/render/bench.ts [outDir=.render-bench]
 */
import type { CameraPreset } from '@spritebook/schema';
import { disposeGpu, type RenderJobSpec, runRenderJob } from '@spritebook/render';

const outDir = process.argv.slice(2)[0] ?? '.render-bench';
const FIXTURE = new URL('./fixtures/skinned-column.glb', import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, '$1');

const camera: CameraPreset = {
  id: 'bench-30x8',
  elevationDeg: 30,
  directions: 8,
  yawOffsetDeg: 0,
  pixelsPerMeter: 48,
  cellPx: { w: 128, h: 128 },
  paddingPx: 8,
  pivot: 'feet-baseline',
  orthographic: true,
};

const spec: RenderJobSpec = {
  jobId: 'bench',
  modelPath: FIXTURE,
  camera,
  frames: 16,
  stylePreset: 'default',
  outDir,
};

let failed = false;
for await (const e of runRenderJob(spec)) {
  if (e.t === 'error') {
    console.error(`render bench failed [${e.code}]: ${e.message}`);
    failed = true;
  } else if (e.t === 'artifact' && e.kind === 'throughput') {
    console.log(await fs.readFile(e.path, 'utf8'));
  } else if (e.t === 'done') {
    console.log(
      `bench: 8 directions x 16 frames in ${e.wallTimeS.toFixed(2)}s`,
    );
  }
}
await disposeGpu();
if (failed) process.exitCode = 1;
