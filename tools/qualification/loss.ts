import { strict as assert } from 'node:assert';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runBakeJob } from '../../packages/pack/bake.ts';
import { PIXEL } from '../../packages/style/presets.ts';
import { getGpu } from '../../packages/render/gpu.ts';

const out = resolve(Deno.args[1]);
await mkdir(out, { recursive: true });
const gpu = await getGpu();
const submit = gpu.device.queue.submit.bind(gpu.device.queue);
let injected = false;
gpu.device.queue.submit = (buffers) => {
  submit(buffers);
  if (!injected) {
    injected = true;
    gpu.device.destroy(); // Real native device destruction immediately after the first submission.
  }
};
const events = [];
for await (
  const event of runBakeJob({
    jobId: 'f2-device-loss',
    characterId: 'migration-control',
    modelPath: fileURLToPath(new URL('../assets/model.glb', import.meta.url)),
    camera: {
      id: 'loss-probe',
      elevationDeg: 30,
      directions: 8,
      yawOffsetDeg: 0,
      pixelsPerMeter: 32,
      cellPx: { w: 100, h: 128 },
      paddingPx: 16,
      pivot: 'feet-baseline',
      orthographic: true,
    },
    style: PIXEL,
    frames: 4,
    outRoot: `${out}/bakes`,
    ...(Deno.args[2] === 'clips'
      ? {
        packDir: fileURLToPath(new URL('../anim/packs/ual/', import.meta.url)),
        clips: [{ clipId: 'idle-loop', frames: 4, speed: 1, holdLast: false }],
      }
      : {}),
  })
) {
  events.push(event);
  console.log(JSON.stringify(event));
}
assert(injected, 'fault must reach the native queue');
const error = events.find((event) => event.t === 'error');
assert(error?.t === 'error');
assert.equal(error.code, 'device-lost');
assert.equal(error.retryable, true);
assert(!events.some((event) => event.t === 'done' || event.t === 'artifact'));
// A failed attempt must not leave a readable completed BakeManifest.
const files = await readdir(`${out}/bakes`, { recursive: true });
assert(!files.some((path) => path.endsWith('manifest.json')));
await writeFile(`${out}/loss.json`, JSON.stringify({ injected, error }, null, 2) + '\n');
