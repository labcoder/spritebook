import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertEquals } from '@std/assert';
import { CAMERA_PRESETS } from '@spritebook/core';
import { PRESETS } from '@spritebook/style';
import { writePins } from '@spritebook/registry';
import { runBakeJob } from './dist/bake.js';

test('a wrong pack pin refuses before model loading or GPU work', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await writePins(`${root}/pins.json`, {
      models: {},
      packs: { ual: 'wrong' },
      rendererVersion: 'legacy',
    });
    const events = await Array.fromAsync(runBakeJob({
      jobId: 'bake',
      characterId: 'hero',
      workspace: `${root}/hero`,
      modelPath: `${root}/deliberately-missing.glb`,
      outRoot: `${root}/output`,
      camera: CAMERA_PRESETS['standard-30'],
      style: PRESETS.pixel,
      frames: 1,
      clips: [{ clipId: 'idle-loop', frames: 1, speed: 1, holdLast: false }],
    }));
    const last = events.at(-1)!;
    assertEquals(last.t === 'error' && last.code, 'pin-mismatch');
    assertEquals(events.some((e) => e.t === 'artifact'), false);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
