import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertEquals } from '@std/assert';
import { decode } from 'fast-png';
import { resourcePath } from '@spritebook/core';
import { resolveStyle } from '@spritebook/style';
import { tryGetGpu } from '../render/dist/gpu.js';
import { type BakeJobSpec, runBakeJob, runLookPreview } from './dist/mod.js';

test('Look frame matches its full bake with custom perspective and lighting', async (t) => {
  if (!(await tryGetGpu())) {
    t.skip('No WebGPU adapter');
    return;
  }
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-preview-'));
  try {
    const spec: BakeJobSpec = {
      jobId: 'look-test',
      characterId: 'preview-test',
      modelPath: resourcePath('rig', 'bodies/ubc-male/body.glb'),
      camera: {
        id: 'preview',
        cellPx: { w: 64, h: 64 },
        pixelsPerMeter: 20,
        paddingPx: 4,
        elevationDeg: 15,
        directions: 2,
        yawOffsetDeg: 25,
        orthographic: false,
        fovDeg: 35,
        pivot: 'feet-baseline',
      },
      style: resolveStyle('clean', {
        temporal: { superSample: 1, clusterVote: false, paletteHysteresisEps: 0, texelSnap: true },
        lighting: { direction: [1, 1, 1], ambient: 1, frame: 'world' },
      }),
      frames: 4,
      clips: [{ clipId: 'walk-loop', frames: 4, speed: 1, holdLast: false }],
      outRoot: dir,
    };
    let bakeDir = '', previewPath = '';
    for await (const event of runBakeJob(spec)) {
      assert(event.t !== 'error', JSON.stringify(event));
      if (event.t === 'artifact' && event.kind === 'bake-dir') bakeDir = event.path;
    }
    for await (
      const event of runLookPreview({
        ...spec,
        outDir: join(dir, 'look'),
        frameIndex: 2,
        direction: 1,
      })
    ) {
      assert(event.t !== 'error', JSON.stringify(event));
      if (event.t === 'artifact' && event.kind === 'look-preview') previewPath = event.path;
    }
    const preview = JSON.parse(await fs.readFile(previewPath, 'utf8'));
    const manifest = JSON.parse(await fs.readFile(join(bakeDir, 'manifest.json'), 'utf8'));
    const rect = manifest.frames.find((f: { direction: number; frame: number }) =>
      f.direction === 1 && f.frame === 2
    ).atlas;
    const atlas = decode(
      new Uint8Array(await fs.readFile(join(bakeDir, `atlas_lit_${rect.pageIndex}.png`))),
    );
    const expected = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++) {
      expected.set(
        atlas.data.subarray(
          ((rect.y + y) * atlas.width + rect.x) * 4,
          ((rect.y + y) * atlas.width + rect.x + 64) * 4,
        ),
        y * 64 * 4,
      );
    }
    const frame = decode(new Uint8Array(await fs.readFile(preview.imagePath)));
    assertEquals(frame.width, 64);
    assertEquals(
      new Uint8Array(frame.data),
      expected,
      'preview and bake use the same framing, pose, lighting and pixels',
    );
    assertEquals(preview.paletteProvisional, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
