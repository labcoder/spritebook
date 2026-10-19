import { tryGetGpu } from '@spritebook/render';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The style seam (D-004): runStyleJob renders the Sx AOVs then styles them,
 * speaking only files + JobEvents. GPU-gated — hosted CI without an adapter
 * skips; SPRITEBOOK_REQUIRE_GPU (the lavapipe lane) forces it to run. The pure
 * CPU pipeline is covered exhaustively from committed fixtures in pipeline_test.
 */
import { assert, assertEquals } from '@std/assert';
import { JobEventSchema } from '@spritebook/schema';
import type { CameraPreset } from '@spritebook/schema';
import { runStyleJob } from './dist/mod.js';
import { PIXEL } from './dist/presets.js';

const GLB = new URL('./fixtures/asymmetric.glb', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const CAM: CameraPreset = {
  id: 'seam-30x2',
  elevationDeg: 30,
  directions: 2,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32,
  cellPx: { w: 64, h: 64 },
  paddingPx: 6,
  pivot: 'feet-baseline',
  orthographic: true,
};

test('style seam: renders + styles end-to-end, files + events only', async (t) => {
  if (!(await tryGetGpu())) { t.skip('No WebGPU adapter'); return; }
  const out = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const events = [];
    for await (
      const e of runStyleJob({
        jobId: 'sj-1',
        modelPath: GLB,
        camera: CAM,
        style: PIXEL,
        frames: 4,
        outDir: out,
      })
    ) events.push(e);

    for (const e of events) {
      JobEventSchema.parse(e);
      assertEquals(e.jobId, 'sj-1');
    }
    const types = events.map((e) => e.t);
    assertEquals(types[0], 'queued');
    assertEquals(types[1], 'started');
    assert(
      types.includes('done'),
      `runs to done; errors: ${JSON.stringify(events.filter((e) => e.t === 'error'))}`,
    );

    const artifacts = events.filter((e) => e.t === 'artifact');
    assert(artifacts.length >= 2, 'styled-frames + style-result artifacts');
    for (const a of artifacts) {
      assert('path' in a && typeof a.path === 'string', 'artifacts are file paths');
    }

    const result = JSON.parse(await fs.readFile(`${out}/style-result.json`, 'utf8'));
    assertEquals(result.stylePresetId, 'pixel');
    // median cut yields <= maxColors (fewer if the fixture has fewer clusters)
    assert(
      result.paletteHex.length > 0 && result.paletteHex.length <= 8,
      `palette size ${result.paletteHex.length}`,
    );
    assertEquals(result.cellPx, { w: 64, h: 64 });
  } finally {
    await fs.rm(out, { recursive: true });
  }
});
