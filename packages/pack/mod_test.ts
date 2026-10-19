import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The bake seam speaks files + JobEvents only, including on failure — a broken
 * input yields a schema-valid error event, never a throw across the seam. The
 * happy path (a real GPU bake) is proven in integration_test.ts.
 */
import { assert, assertEquals } from '@std/assert';
import { JobEventSchema } from '@spritebook/schema';
import type { CameraPreset } from '@spritebook/schema';
import { PIXEL } from '@spritebook/style';
import { runBakeJob } from './dist/mod.js';

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

test('bake seam: a missing model becomes an error EVENT, not a throw', async () => {
  const out = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const events = [];
    for await (
      const e of runBakeJob({
        jobId: 'bk-err',
        characterId: 'nope',
        modelPath: `${out}/does-not-exist.glb`,
        camera: CAM,
        style: PIXEL,
        frames: 2,
        outRoot: out,
      })
    ) events.push(e);

    for (const e of events) JobEventSchema.parse(e);
    assertEquals(events.map((e) => e.t).slice(0, 2), ['queued', 'started']);
    const err = events.at(-1)!;
    assert(err.t === 'error' && err.code === 'bake-failed', 'terminal error event');
    assert(!events.some((e) => e.t === 'done'), 'no done after failure');
  } finally {
    await fs.rm(out, { recursive: true });
  }
});
