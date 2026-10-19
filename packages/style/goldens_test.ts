import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Per-preset perceptual goldens on the asymmetric fixture (P2-T2 acceptance).
 * The style stage is deterministic CPU over the committed AOVs, so the goldens
 * reproduce byte-for-byte anywhere — this runs on hosted CI, no GPU. On any
 * mismatch it writes actual/expected/diff PNGs to tests/failures/ (a red-splat
 * heatmap localizes a regression in seconds). Regenerate goldens only via
 * fixtures/_gen-goldens.ts, never by loosening the assertion.
 */
import { assert, assertEquals } from '@std/assert';
import { fileURLToPath } from 'node:url';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import pixelmatch from 'pixelmatch';
import type { CameraPreset } from '@spritebook/schema';
import type { AovSource } from './dist/contracts.js';
import { styleFromAovs } from './dist/pipeline.js';
import { PRESETS } from './dist/presets.js';
import { GOLDEN_FRAMES, goldenName } from './fixtures/golden-config.ts';

const GOLDENS = fileURLToPath(new URL('./fixtures/goldens/', import.meta.url));
const FRAMES = fileURLToPath(new URL('./fixtures/aov/frames/', import.meta.url));
const FAILURES = fileURLToPath(new URL('../../tests/failures/style-goldens/', import.meta.url));

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

async function readRgba(path: string) {
  const img = decodePng(new Uint8Array(await fs.readFile(path)));
  return { w: img.width, h: img.height, data: img.data as Uint8Array };
}

test('per-preset styled goldens on the asymmetric fixture', async () => {
  for (const [id, preset] of Object.entries(PRESETS)) {
    const out = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
    try {
      const r = await styleFromAovs(SRC, CAM, preset, out);
      for (const [d, f] of GOLDEN_FRAMES) {
        const frameName = `d${String(d).padStart(2, '0')}_f${String(f).padStart(3, '0')}.png`;
        const actual = await readRgba(`${r.styledDir}/${frameName}`);
        const expected = await readRgba(`${GOLDENS}/${goldenName(id, d, f)}`);
        assertEquals([actual.w, actual.h], [expected.w, expected.h], `${id} dims`);
        const diff = new Uint8Array(actual.w * actual.h * 4);
        const n = pixelmatch(actual.data, expected.data, diff, actual.w, actual.h, {
          threshold: 0.1,
        });
        if (n > 0) {
          await fs.mkdir(FAILURES, { recursive: true });
          const base = `${FAILURES}/${goldenName(id, d, f).replace('.png', '')}`;
          const png = (data: Uint8Array) => encodePng({ width: actual.w, height: actual.h, data });
          await fs.writeFile(`${base}-actual.png`, png(actual.data));
          await fs.writeFile(`${base}-expected.png`, png(expected.data));
          await fs.writeFile(`${base}-diff.png`, png(diff));
        }
        assert(
          n === 0,
          `${id} d${d} f${f}: ${n}px differ from golden (see tests/failures/style-goldens/)`,
        );
      }
    } finally {
      await fs.rm(out, { recursive: true });
    }
  }
});
