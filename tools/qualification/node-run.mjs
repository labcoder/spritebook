import './node-environment.mjs';
import { once } from 'node:events';

if (process.env.SPRITEBOOK_OWNED_START === '1') {
  const [data] = await once(process.stdin, 'data');
  if (data.toString().trim() !== 'start') throw new Error('invalid owned-process startup');
  process.stdin.destroy();
}

let gpu;
try {
  // Keep native load errors inside the terminal diagnostic boundary.
  const { create, globals } = await import('./vendor/webgpu/index.js');
  Object.assign(globalThis, globals);
  const backend = process.env.SPRITEBOOK_GPU_BACKEND ?? 'vulkan';
  process.env.DENO_WEBGPU_BACKEND = `dawn-${backend}`;
  process.env.SPRITEBOOK_REQUIRE_GPU = '1';
  gpu = create([`backend=${backend}`]);
  Object.defineProperty(navigator, 'gpu', { value: gpu, configurable: true });
  if (process.argv[2] === 'checks') await import('./core/checks.mjs');
  else if (process.argv[2] === 'loss') await import('./core/loss.mjs');
  else await import('./core/workload.mjs');
} catch (error) {
  console.error(JSON.stringify({
    t: 'error',
    code: error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_DLOPEN_FAILED'
      ? 'native-addon-load'
      : 'qualification-failed',
    message: error.message,
    retryable: false,
  }));
  process.exitCode = 1;
} finally {
  delete navigator.gpu;
  gpu = undefined;
}
