import { strict as assert } from 'node:assert';
import { mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';

const [exeArg, outArg] = process.argv.slice(2);
assert(exeArg && outArg, 'usage: node delivery.mjs <installed-proof-executable> <new-results>');
const exe = resolve(exeArg), out = resolve(outArg);
await mkdir(out);
const results = {};
function launch(dir, ...args) {
  return spawn(exe, [dir, ...args], {
    cwd: out,
    windowsHide: true,
    timeout: 60_000,
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      USERPROFILE: process.env.USERPROFILE,
      PATH: '',
      TEMP: out,
      TMP: out,
    },
  });
}
async function run(name, args, expectedCode = 0, dir = `${out}/${name}`) {
  const child = launch(dir, ...args);
  const [code] = await once(child, 'close');
  assert.equal(code, expectedCode, `installed ${name} exit code`);
  const report = JSON.parse(await readFile(`${dir}/tauri-launch.json`, 'utf8'));
  assert.equal(report.code, expectedCode);
  assert.equal(report.path, '');
  assert(
    (await realpath(report.node)).startsWith((await realpath(dirname(exe))) + '\\'),
    'runtime must be app-owned',
  );
  results[name] = report;
  await writeFile(`${out}/${name}.ndjson`, await readFile(`${dir}/stdout.ndjson`));
  await writeFile(`${out}/${name}.stderr`, await readFile(`${dir}/stderr.log`));
  return dir;
}
async function hashes(dir) {
  const result = {};
  for (const name of (await readdir(dir, { recursive: true, withFileTypes: true }))) {
    if (!name.isFile()) continue;
    const path = join(name.parentPath, name.name);
    result[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return result;
}
const bake = await run('bake', ['1', 'pixel', 'cold']);
const prior = await hashes(`${bake}/bakes`);
const checks = await run('checks', ['checks']);
const checkEvents = (await readFile(`${checks}/stdout.ndjson`, 'utf8')).trim().split('\n').map(
  JSON.parse,
);
assert(checkEvents.some((e) => e.t === 'checks-done' && e.passed > 80));
results.carriedChecks = checkEvents.at(-1).passed;
for (const mode of ['stub', 'clips']) {
  const dir = await run(`loss-${mode}`, ['loss', mode], 0, bake);
  const loss = JSON.parse(await readFile(`${dir}/loss.json`, 'utf8'));
  assert.equal(loss.error.code, 'device-lost');
  assert.equal(loss.error.retryable, true);
}

const runtime = results.bake.runtime;
const files = await readdir(runtime, { recursive: true });
assert(!files.some((name) => /\.(ts|tsx|rs)$/.test(name) || /node_modules/.test(name)));
for (
  const [name, file, diagnostic] of [
    ['missing-addon', 'dawn.node', 'native-addon-load'],
    ['missing-loader', 'vulkan-1.dll', 'No WebGPU adapter'],
  ]
) {
  const path = `${runtime}/vendor/webgpu/dist/win32-x64/${file}`;
  await rename(path, `${path}.missing`);
  try {
    const dir = await run(name, ['1', 'pixel', 'cold'], 1, bake);
    const stderr = await readFile(`${dir}/stderr.log`, 'utf8');
    const stdout = await readFile(`${dir}/stdout.ndjson`, 'utf8');
    assert((stderr + stdout).includes(diagnostic));
    assert(!stdout.includes('"t":"done"'));
  } finally {
    await rename(`${path}.missing`, path);
  }
}

const cancelDir = bake;
const owner = launch(cancelDir, '4', 'pixel', 'cold');
const ownerClosed = once(owner, 'close');
let rendered = false;
const deadline = Date.now() + 30_000;
try {
  while (Date.now() < deadline && owner.exitCode === null) {
    const frames = await readdir(`${cancelDir}/temp`, { recursive: true }).catch(() => []);
    if (frames.some((name) => name.endsWith('.png'))) {
      rendered = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert(rendered, 'cancel must interrupt real rendered frames, not startup');
  const children = JSON.parse(
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${owner.pid}" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress`,
    ], { encoding: 'utf8' }),
  );
  const workers = Array.isArray(children) ? children : [children];
  const expectedNode = await realpath(results.bake.node);
  for (const child of workers) child.ExecutablePath = await realpath(child.ExecutablePath);
  const nodeWorker = workers.find((child) => child.ExecutablePath === expectedNode);
  assert(nodeWorker, 'owner must have an app-owned Node child');
  results.nativeModules = JSON.parse(
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @((Get-Process -Id ${nodeWorker.ProcessId}).Modules | Where-Object { $_.ModuleName -match 'MSVCP140|VCRUNTIME140|vulkan-1|dawn.node|^node.exe$' } | Select-Object -ExpandProperty FileName) | ConvertTo-Json -Compress`,
    ], { encoding: 'utf8' }),
  );
  owner.kill();
  await ownerClosed;
  for (const worker of workers) {
    const live = execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `if (Get-Process -Id ${worker.ProcessId} -ErrorAction SilentlyContinue) { exit 1 }`,
    ]);
    assert.equal(live.length, 0);
  }
  const files = await readdir(`${cancelDir}/bakes`, { recursive: true });
  assert.deepEqual(
    files.filter((name) => name.endsWith('manifest.json')).map((name) =>
      resolve(cancelDir, 'bakes', name)
    ).sort(),
    Object.keys(prior).filter((name) => name.endsWith('manifest.json')).sort(),
  );
  const stdout = await readFile(`${cancelDir}/stdout.ndjson`, 'utf8');
  assert(!stdout.includes('"t":"done"'));
  await writeFile(`${out}/cancelled.ndjson`, stdout);
  results.cancel = {
    rendered,
    workers,
    ownerExitCode: owner.exitCode,
    ownerSignal: owner.signalCode,
  };
} finally {
  if (owner.exitCode === null) owner.kill();
}
await run('retry', ['4', 'pixel', 'cold'], 0, bake);
const after = await hashes(`${bake}/bakes`);
for (const [path, hash] of Object.entries(prior)) {
  assert.equal(after[path], hash, `prior bake byte changed: ${path}`);
}
results.priorArtifactsUnchanged = true;
results.retryCompleted = true;
await writeFile(`${out}/delivery.json`, JSON.stringify(results, null, 2) + '\n');
console.log(
  JSON.stringify({
    carriedChecks: results.carriedChecks,
    retryCompleted: true,
    priorArtifactsUnchanged: true,
  }),
);
