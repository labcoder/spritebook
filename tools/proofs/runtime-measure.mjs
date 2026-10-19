// Sequential paired runs; a failed image/process is recorded once, never auto-retried.
import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const [runtimeArg, nodeArg, outArg, legacyArg, backend = 'vulkan'] = process.argv.slice(2);
assert(
  runtimeArg && nodeArg && outArg && legacyArg,
  'usage: node runtime-measure.mjs <F2-control-runtime> <production-Node-runtime> <new-results> <isolated-legacy-checkout>',
);
assert(
  ['vulkan', 'd3d12'].includes(backend),
  'Windows backend must be vulkan or d3d12',
);
const runtime = resolve(runtimeArg);
const nodeRuntime = resolve(nodeArg);
const legacyCwd = resolve(legacyArg);
const workload = fileURLToPath(new URL('./runtime-workload.ts', import.meta.url));
const out = resolve(outArg);
await mkdir(out);
const measurements = [];
const gpuSamples = [];
const monitor = spawn('nvidia-smi', [
  '--query-gpu=timestamp,index,driver_version,memory.used',
  '--format=csv,noheader,nounits',
  '--loop-ms=100',
]);
const monitorErrors = [];
monitor.stderr.on('data', (chunk) => monitorErrors.push(chunk.toString()));
monitor.on('error', (error) => monitorErrors.push(error.message));
createInterface({ input: monitor.stdout }).on('line', (line) => {
  const [timestamp, index, driver, used] = line.split(',').map((part) => part.trim());
  if (Number.isFinite(Number(used))) {
    gpuSamples.push({
      at: performance.now(),
      timestamp,
      index,
      driver,
      usedMiB: Number(used),
    });
  }
});

async function run(engine, id, sample, style, temperature, mirror, fixture) {
  const dir = `${out}/${id}/${engine}`;
  await mkdir(dir, { recursive: true });
  const temp = `${dir}/temp`;
  await mkdir(temp, { recursive: true });
  const args = [
    dir,
    String(sample),
    style,
    temperature,
    String(mirror),
    fixture,
  ];
  const command = engine === 'node' ? `${nodeRuntime}/node.exe` : 'deno';
  const argv = engine === 'node' ? [workload, nodeRuntime, runtime, ...args] : [
    'run',
    '--no-config',
    '--no-lock',
    '--node-modules-dir=none',
    '--cached-only',
    '--no-check',
    '--unstable-webgpu',
    '-A',
    `${runtime}/core/control-workload.mjs`,
    ...args,
  ];
  const start = performance.now();
  const child = spawn(command, argv, {
    cwd: legacyCwd,
    env: {
      ...process.env,
      DENO_WEBGPU_BACKEND: backend === 'd3d12' ? 'dx12' : 'vulkan',
      SPRITEBOOK_REQUIRE_GPU: '1',
      SPRITEBOOK_GPU_BACKEND: backend,
      TEMP: temp,
      TMP: temp,
    },
    windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => stdout += chunk);
  child.stderr.on('data', (chunk) => stderr += chunk);
  const [code] = await once(child, 'close');
  const processWallS = (performance.now() - start) / 1000;
  await writeFile(`${dir}/${temperature}.ndjson`, stdout);
  await writeFile(`${dir}/${temperature}.stderr`, stderr);
  assert.equal(code, 0, `${engine} ${id} ${temperature}: ${stderr}\n${stdout}`);
  const report = JSON.parse(
    await readFile(`${dir}/${temperature}.json`, 'utf8'),
  );
  const memory = gpuSamples.filter((sample) => sample.at >= start);
  measurements.push({
    engine,
    id,
    sample,
    style,
    temperature,
    mirror,
    fixture,
    processWallS,
    ...report,
    gpuGlobalPeakMiB: memory.length ? Math.max(...memory.map((sample) => sample.usedMiB)) : null,
    gpuGlobalMinMiB: memory.length ? Math.min(...memory.map((sample) => sample.usedMiB)) : null,
  });
  await writeFile(
    `${out}/measurements.json`,
    JSON.stringify(measurements, null, 2) + '\n',
  );
  console.log(`${engine} ${id} ${temperature}: ${processWallS.toFixed(3)}s`);
}

try {
  for (const sample of [1, 2, 4]) {
    for (const trial of [1, 2, 3]) {
      // Alternate order to avoid giving one engine all the first-run driver/cache costs.
      for (const engine of trial % 2 ? ['deno', 'node'] : ['node', 'deno']) {
        const id = `pixel-s${sample}-r${trial}`;
        for (const temperature of ['cold', 'warm']) {
          await run(engine, id, sample, 'pixel', temperature, false, 'rigged');
        }
      }
    }
  }
  for (const style of ['pixel', 'cel-2', 'painterly', 'clean']) {
    for (const engine of ['deno', 'node']) {
      await run(
        engine,
        `asymmetric-${style}`,
        4,
        style,
        'cold',
        false,
        'asymmetric',
      );
    }
  }
  for (const engine of ['deno', 'node']) {
    await run(engine, 'mirrored', 1, 'pixel', 'cold', true, 'rigged');
  }
  for (const measurement of measurements) {
    const first = measurements.find((m) =>
      m.engine === measurement.engine && m.sample === measurement.sample &&
      m.fixture === measurement.fixture && m.style === measurement.style &&
      m.mirror === measurement.mirror && m.temperature === 'cold'
    );
    assert.deepEqual(
      measurement.pages,
      first.pages,
      'same-machine bake/cache canary',
    );
  }
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const timings = [1, 2, 4].map((sample) => {
    const times = (engine, temperature) =>
      measurements.filter((m) =>
        m.engine === engine && m.temperature === temperature &&
        m.fixture === 'rigged' &&
        !m.mirror && m.sample === sample
      ).map((m) => m.processWallS);
    const coldDeno = median(times('deno', 'cold'));
    const coldNode = median(times('node', 'cold'));
    const warmDeno = median(times('deno', 'warm'));
    const warmNode = median(times('node', 'warm'));
    return {
      sample,
      coldDeno,
      coldNode,
      warmDeno,
      warmNode,
      coldRegressionPct: (coldNode / coldDeno - 1) * 100,
      warmRegressionPct: (warmNode / warmDeno - 1) * 100,
    };
  });
  await writeFile(
    `${out}/summary.json`,
    JSON.stringify(
      {
        backend,
        timings,
        budgetMet: timings.every((t) => t.coldRegressionPct <= 10 && t.warmRegressionPct <= 10),
        measurements: measurements.length,
        hardware: execFileSync('nvidia-smi', [
          '--query-gpu=name,driver_version,memory.total',
          '--format=csv,noheader,nounits',
        ], { encoding: 'utf8' }).trim(),
        gpuMemoryMeaning:
          'whole-GPU sampled use, including desktop; not process allocation or VRAM admission',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  monitor.kill();
  await writeFile(
    `${out}/gpu-memory.json`,
    JSON.stringify({ gpuSamples, monitorErrors }) + '\n',
  );
}
