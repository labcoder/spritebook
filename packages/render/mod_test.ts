import { assert, assertEquals } from 'jsr:@std/assert@1';
import { JobEventSchema } from '@spritebook/schema';
import { runRenderJob } from './mod.ts';

Deno.test('render seam contract: files + events only, vocabulary in order', async () => {
  const events = [];
  for await (
    const e of runRenderJob({
      jobId: 'job-1',
      modelPath: 'fixtures/model.glb',
      cameraPreset: 'default',
      stylePreset: 'default',
      outDir: 'out',
    })
  ) {
    events.push(e);
  }
  assertEquals(events.map((e) => e.t), ['queued', 'started', 'progress', 'artifact', 'done']);
  for (const e of events) {
    JobEventSchema.parse(e); // every emitted event validates against the schema
    assertEquals(e.jobId, 'job-1');
  }
  const artifact = events.find((e) => e.t === 'artifact');
  assert(
    artifact && 'path' in artifact && typeof artifact.path === 'string',
    'artifacts are file paths - pixels never cross the seam',
  );
});
