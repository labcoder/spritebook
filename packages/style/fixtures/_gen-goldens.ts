import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Generate the per-preset perceptual goldens (checked in). The style stage is
 * pure deterministic CPU over the committed AOVs, so these goldens are portable
 * — goldens_test.ts reproduces them byte-for-byte on any machine. Regenerate +
 * review the image diff whenever the pipeline intentionally changes output.
 *
 *   node tools/run.mjs \
 *     packages/style/fixtures/_gen-goldens.ts
 */
import type { CameraPreset } from '@spritebook/schema';
import { styleFromAovs } from '../dist/pipeline.js';
import { PRESETS } from '../dist/presets.js';
import { GOLDEN_FRAMES, goldenName } from './golden-config.ts';

const here = new URL('.', import.meta.url);
const win = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FRAMES = win(new URL('aov/frames/', here));

const src = { framesDir: FRAMES, directions: 2, frames: 6, width: 256, height: 256 };
const camera: CameraPreset = {
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

const goldensDir = win(new URL('goldens/', here));
await fs.mkdir(goldensDir, { recursive: true });

for (const [id, preset] of Object.entries(PRESETS)) {
  const out = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  const r = await styleFromAovs(src, camera, preset, out);
  for (const [d, f] of GOLDEN_FRAMES) {
    const frameName = `d${String(d).padStart(2, '0')}_f${String(f).padStart(3, '0')}.png`;
    await fs.copyFile(`${r.styledDir}/${frameName}`, `${goldensDir}/${goldenName(id, d, f)}`);
  }
  await fs.rm(out, { recursive: true });
  console.log(`golden: ${id}`);
}
console.log('goldens written to packages/style/fixtures/goldens/');
