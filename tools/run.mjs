import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { disposeGpu } from '../packages/render/dist/gpu.js';

assert(process.argv[2], 'usage: node tools/run.mjs <tool.ts> [arguments]');
process.argv.splice(1, 1);
try {
  await import(pathToFileURL(resolve(process.argv[1])).href);
} finally {
  await disposeGpu();
}
