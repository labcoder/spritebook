import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The D-004 seam contract: runRenderJob speaks only files + JobEvents, never
 * pixels or GPU objects. GPU-gated — skips on hosted CI without an adapter; the
 * lavapipe lane sets SPRITEBOOK_REQUIRE_GPU to enforce it.
 */
import { assert, assertEquals } from '@std/assert';
import { JobEventSchema } from '@spritebook/schema';
import type { CameraPreset } from '@spritebook/schema';
import { type RenderJobSpec, runRenderJob } from './dist/mod.js';
import { tryGetGpu } from './dist/gpu.js';

const FIXTURE = new URL('./fixtures/skinned-column.glb', import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, '$1');

const camera: CameraPreset = {
  id: 'seam-30x4',
  elevationDeg: 30,
  directions: 4,
  yawOffsetDeg: 0,
  pixelsPerMeter: 48,
  cellPx: { w: 128, h: 128 },
  paddingPx: 8,
  pivot: 'feet-baseline',
  orthographic: true,
};

test('render seam: files + events only, valid vocabulary, artifacts are paths', async (t) => {
  const gpu = await tryGetGpu();
  if (!gpu) { t.skip('No WebGPU adapter'); return; } // hosted CI without a GPU skips; lavapipe enforces
  const outDir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const spec: RenderJobSpec = {
      jobId: 'job-r1',
      modelPath: FIXTURE,
      camera,
      frames: 2,
      stylePreset: 'default',
      outDir,
    };
    const events = [];
    for await (const e of runRenderJob(spec)) events.push(e);

    for (const e of events) {
      JobEventSchema.parse(e); // every emitted event validates against the schema
      assertEquals(e.jobId, 'job-r1');
    }
    const types = events.map((e) => e.t);
    assertEquals(types[0], 'queued');
    assertEquals(types[1], 'started');
    assert(types.includes('done'), 'job runs to done');
    assert(
      !types.includes('error'),
      `no error events: ${JSON.stringify(events.filter((e) => e.t === 'error'))}`,
    );

    const artifacts = events.filter((e) => e.t === 'artifact');
    assert(artifacts.length >= 3, 'summary + frames + throughput artifacts');
    for (const a of artifacts) {
      assert(
        'path' in a && typeof a.path === 'string',
        'artifacts are file paths — pixels never cross the seam',
      );
    }

    // the promised products exist on disk
    const summary = JSON.parse(await fs.readFile(`${outDir}/render-summary.json`, 'utf8'));
    assertEquals(summary.directions, 4);
    assertEquals(summary.pivotPx, { x: 64, y: 120 });
    const tp = JSON.parse(await fs.readFile(`${outDir}/throughput.json`, 'utf8'));
    assert(tp.frames === 8 && tp.fps > 0, 'throughput report written with real numbers');
  } finally {
    await fs.rm(outDir, { recursive: true });
  }
});
