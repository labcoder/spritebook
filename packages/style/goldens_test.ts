/**
 * Per-preset perceptual goldens on the asymmetric fixture (P2-T2 acceptance).
 * The style stage is deterministic CPU over the committed AOVs, so the goldens
 * reproduce byte-for-byte anywhere — this runs on hosted CI, no GPU. On any
 * mismatch it writes actual/expected/diff PNGs to tests/failures/ (a red-splat
 * heatmap localizes a regression in seconds). Regenerate goldens only via
 * fixtures/_gen-goldens.ts, never by loosening the assertion.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import pixelmatch from 'pixelmatch';
import type { CameraPreset } from '@spritebook/schema';
import type { AovSource } from './contracts.ts';
import { styleFromAovs } from './pipeline.ts';
import { PRESETS } from './presets.ts';
import { GOLDEN_FRAMES, goldenName } from './fixtures/golden-config.ts';

const win = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const GOLDENS = win(new URL('./fixtures/goldens/', import.meta.url));
const FRAMES = win(new URL('./fixtures/aov/frames/', import.meta.url));
const FAILURES = win(new URL('../../tests/failures/style-goldens/', import.meta.url));

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
  const img = decodePng(await Deno.readFile(path));
  return { w: img.width, h: img.height, data: img.data as Uint8Array };
}

Deno.test('per-preset styled goldens on the asymmetric fixture', async () => {
  for (const [id, preset] of Object.entries(PRESETS)) {
    const out = await Deno.makeTempDir();
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
          await Deno.mkdir(FAILURES, { recursive: true });
          const base = `${FAILURES}/${goldenName(id, d, f).replace('.png', '')}`;
          const png = (data: Uint8Array) => encodePng({ width: actual.w, height: actual.h, data });
          await Deno.writeFile(`${base}-actual.png`, png(actual.data));
          await Deno.writeFile(`${base}-expected.png`, png(expected.data));
          await Deno.writeFile(`${base}-diff.png`, png(diff));
        }
        assert(
          n === 0,
          `${id} d${d} f${f}: ${n}px differ from golden (see tests/failures/style-goldens/)`,
        );
      }
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  }
});
