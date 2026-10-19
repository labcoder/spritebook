// Exercise an actual copied payload, outside the checkout and without developer tools on PATH.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sourceArg, reportArg, gpuArg] = process.argv.slice(2);
assert(
  sourceArg && reportArg,
  'usage: node tools/runtime/check.mjs <runtime> <new-report-directory> [--gpu]',
);
const source = resolve(sourceArg), report = resolve(reportArg);
await mkdir(report);
const root = await mkdtemp(join(tmpdir(), 'SpriteBook é 空 '));
const runtime = join(root, 'runtime');
await cp(source, runtime, { recursive: true, dereference: true });
const receipt = JSON.parse(await readFile(join(runtime, 'receipt.json'), 'utf8'));
for (const [path, expected] of Object.entries(receipt.files)) {
  const actual = createHash('sha256').update(await readFile(join(runtime, path))).digest('hex');
  assert.equal(actual, expected, `Runtime seal: ${path}`);
}
const env = {
  ...process.env,
  PATH: '',
  NODE_PATH: '',
  NODE_OPTIONS: '',
  SPRITEBOOK_RESOURCES: join(runtime, 'assets'),
  SPRITEBOOK_UV_BIN: join(runtime, process.platform === 'win32' ? 'uv.exe' : 'uv'),
};
const binary = join(runtime, process.platform === 'win32' ? 'spritebook.exe' : 'spritebook');
const transcript = [];
function cli(args, allowUnavailable = false) {
  let output, code = 0;
  try {
    output = execFileSync(binary, args, {
      cwd: root,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 300_000,
    });
  } catch (error) {
    code = error.status;
    output = error.stdout?.toString() ?? '';
    if (!allowUnavailable) throw error;
  }
  transcript.push({ args, code, stdout: output });
  return { code, output };
}
assert.equal(cli(['--version']).output.trim(), receipt.version);
const catalog = JSON.parse(cli(['models', 'list', '--json']).output);
assert(catalog.models.some((model) => model.id === 'trellis2-4b'));
const doctor = cli(['doctor', '--json'], gpuArg !== '--gpu');
const health = JSON.parse(doctor.output);
assert(
  doctor.code === 0 || health.available === false,
  'Only adapter absence may pass a non-GPU smoke',
);

// These dynamic importer branches and CJS-relative assets must exist in the installed tree.
const obj = join(root, 'triangle.obj');
await writeFile(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
const node = join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
const importer = pathToFileURL(join(runtime, 'node_modules/@spritebook/importer/dist/mod.js')).href;
execFileSync(node, [
  '--input-type=module',
  '-e',
  `
  import { strict as assert } from 'node:assert';
  const { importToCanonical } = await import(${JSON.stringify(importer)});
  const result = await importToCanonical({ input: ${JSON.stringify(obj)} });
  assert.equal(result.provenance.tool, 'obj2gltf');
  assert(result.bytes.length > 100);
`,
], { cwd: root, env, windowsHide: true, timeout: 60_000 });

if (gpuArg === '--gpu') {
  const events = cli([
    'bake',
    '--model',
    join(runtime, 'sample/asymmetric.glb'),
    '--character',
    'installed',
    '--out',
    join(root, 'bakes'),
    '--style',
    'pixel',
    '--directions',
    '8',
    '--frames',
    '4',
    '--json',
  ]).output.trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).t, 'done');
  const manifestPath = events.find((event) =>
    event.t === 'artifact' && event.kind === 'bake-manifest'
  )?.path;
  assert(manifestPath, 'Installed bake manifest');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.frames.length, 32);
  assert.deepEqual(manifest.atlases.map((page) => page.pass).sort(), [
    'albedo',
    'depth',
    'lit',
    'mask',
    'normal',
  ]);
  cli([
    'export',
    '--bake',
    dirname(manifestPath),
    '--out',
    join(root, 'exports'),
    '--targets',
    'godot,aseprite,texturepacker,strips',
    '--json',
  ]);
  assert((await readFile(join(root, 'exports/godot/installed.tres'))).length > 0);
}
await writeFile(
  join(report, 'report.json'),
  JSON.stringify(
    {
      root,
      receipt,
      gpu: gpuArg === '--gpu',
      checks: [
        'all sealed files',
        'empty PATH',
        'Unicode path',
        'version',
        'catalog',
        'doctor',
        'OBJ importer/CJS assets',
        ...(gpuArg === '--gpu' ? ['styled/AOV bake', 'all four exporters'] : []),
      ],
      transcript,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Installed payload checks passed; retained at ${root}`);
