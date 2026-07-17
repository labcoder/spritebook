/**
 * The bake seam speaks files + JobEvents only, including on failure — a broken
 * input yields a schema-valid error event, never a throw across the seam. The
 * happy path (a real GPU bake) is proven in integration_test.ts.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { JobEventSchema } from '@spritebook/schema';
import type { CameraPreset } from '@spritebook/schema';
import { PIXEL_8 } from '@spritebook/style';
import { runBakeJob } from './mod.ts';

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

Deno.test('bake seam: a missing model becomes an error EVENT, not a throw', async () => {
  const out = await Deno.makeTempDir();
  try {
    const events = [];
    for await (
      const e of runBakeJob({
        jobId: 'bk-err',
        characterId: 'nope',
        modelPath: `${out}/does-not-exist.glb`,
        camera: CAM,
        style: PIXEL_8,
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
    await Deno.remove(out, { recursive: true });
  }
});
