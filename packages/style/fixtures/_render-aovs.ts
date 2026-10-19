import { promises as fs } from 'node:fs';
/**
 * Render the asymmetric fixture to Sx AOV PNGs, checked in as the style test
 * fixtures. Run ONCE on a GPU (this box: SPRITEBOOK_GPU_BACKEND=vulkan); the style
 * stage is pure CPU, so downstream style tests read these committed AOVs and run
 * deterministically on any machine (no GPU needed in CI).
 *
 * 1x output is 64px, supersample S=4 -> 256px render. Idle pose = the low-motion
 * loop the flicker metric measures. Leaves packages/style/fixtures/aov/frames/.
 *
 *   SPRITEBOOK_GPU_BACKEND=vulkan node tools/run.mjs \
 *     packages/style/fixtures/_render-aovs.ts
 */
import type { CameraPreset } from '@spritebook/schema';
import { runRenderJob } from '@spritebook/render';

const here = new URL('.', import.meta.url);
const win = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const S = 4;

const camera: CameraPreset = {
  id: 'style-fixture-30x2',
  elevationDeg: 30,
  directions: 2,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32 * S,
  cellPx: { w: 64 * S, h: 64 * S },
  paddingPx: 6 * S,
  pivot: 'feet-baseline',
  orthographic: true,
};

const outDir = win(new URL('aov', here));
let failed = false;
for await (
  const e of runRenderJob({
    jobId: 'style-fx',
    modelPath: win(new URL('asymmetric.glb', here)),
    camera,
    frames: 6,
    pose: 'idle',
    stylePreset: '',
    outDir,
  })
) {
  if (e.t === 'error') {
    console.error(`fixture render failed [${e.code}]: ${e.message}`);
    failed = true;
  }
}
// throughput.json is machine-specific; keep only the AOV frames + summary
await fs.rm(`${outDir}/throughput.json`).catch(() => {});
if (failed) process.exit(1);
console.log('AOV fixtures rendered to packages/style/fixtures/aov/frames/');
