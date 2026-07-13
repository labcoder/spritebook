import { assert, assertEquals } from 'jsr:@std/assert@1';
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
  assertEquals(events.map((e) => e.event), ['queued', 'started', 'progress', 'artifact', 'done']);
  assert(events.every((e) => e.jobId === 'job-1'));
  assert(events.every((e) => !Number.isNaN(Date.parse(e.ts))), 'timestamps are ISO-8601');
  const artifact = events.find((e) => e.event === 'artifact');
  assert(
    artifact && 'path' in artifact && typeof artifact.path === 'string',
    'artifacts are file paths - pixels never cross the seam',
  );
});
