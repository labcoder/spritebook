// Exercise an actual copied payload, outside the checkout and without developer tools on PATH.
import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, globSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
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
  LOCALAPPDATA: join(root, 'profile'),
  XDG_DATA_HOME: join(root, 'profile'),
  UV_CACHE_DIR: join(root, 'uv-cache'),
  UV_PYTHON_INSTALL_DIR: join(root, 'python'),
  UV_PYTHON_PREFERENCE: 'only-managed',
};
for (
  const name of [
    'UV_PROJECT_ENVIRONMENT',
    'UV_PYTHON',
    'SPRITEBOOK_SIDECAR_DIR',
    'PYTHONPATH',
    'PYTHONHOME',
  ]
) delete env[name];
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
if (
  health.adapter?.vendor === 'nvidia' && process.platform === 'win32' &&
  existsSync(join(process.env.SystemRoot, 'System32/nvidia-smi.exe'))
) {
  assert(health.vramGb > 0, 'Installed CUDA/VRAM discovery must not depend on PATH');
}

// These dynamic importer branches and CJS-relative assets must exist in the installed tree.
const obj = join(root, 'triangle.obj');
await writeFile(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
const node = join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
const importer = pathToFileURL(join(runtime, 'node_modules/@spritebook/importer/dist/mod.js')).href;
for (const mode of ['production', 'development']) {
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
  ], { cwd: root, env: { ...env, NODE_ENV: mode }, windowsHide: true, timeout: 60_000 });
}

if (gpuArg === '--gpu') {
  const image = join(root, 'reference.png'), workspace = join(root, 'hero');
  const imageModule =
    pathToFileURL(join(runtime, 'node_modules/@spritebook/image/dist/mod.js')).href;
  execFileSync(node, [
    '--input-type=module',
    '-e',
    `
    import { writeFile } from 'node:fs/promises';
    const { encode } = await import(${JSON.stringify(imageModule)});
    const data = new Uint8Array(512 * 512 * 4);
    for(let i=0;i<data.length;i+=4)data.set([128,64,32,255],i);
    await writeFile(${JSON.stringify(image)},encode({width:512,height:512,data}));
  `,
  ], { cwd: root, env, windowsHide: true });
  const models = join(root, 'models');
  cli(['models', 'install', 'fixture-gen', '--models-dir', models, '--json']);
  const relocated = join(root, 'models moved é 空');
  await rename(models, relocated);
  env.SPRITEBOOK_MODELS_DIR = relocated;
  for (
    const args of [
      [
        'gen',
        '--workspace',
        workspace,
        '--character',
        'hero',
        '--image',
        image,
        '--model',
        'fixture-gen',
        '--seed',
        '7',
        '--height',
        '1.7',
      ],
      ['pick', '--workspace', workspace, '--result', 'r1'],
      [
        'rig',
        '--track-a',
        '--body',
        'ubc-male',
        '--workspace',
        workspace,
        '--model',
        join(workspace, 'canonical/model.glb'),
        '--out',
        join(workspace, 'rig'),
      ],
      ['rig', '--accept', '--workspace', workspace],
      ['anim', '--enable', 'idle-loop:2,walk-loop:2,punch-jab:2', '--workspace', workspace],
      ['anim', '--preview', 'idle-loop', '--workspace', workspace],
      ['look', '--workspace', workspace, '--style', 'pixel', '--cell', '100x128'],
    ]
  ) cli([...args, '--json']);
  for (const temperature of ['cold', 'warm']) {
    cli([
      'bake',
      '--workspace',
      workspace,
      '--cache',
      join(root, 'cache'),
      '--only-invalidated',
      '--json',
    ]);
    const character = JSON.parse(await readFile(join(workspace, 'character.json'), 'utf8'));
    const bake = join(workspace, 'bakes', `bake-${character.lastBakeId}`);
    const manifest = JSON.parse(await readFile(join(bake, 'manifest.json'), 'utf8'));
    assert.equal(manifest.frames.length, 48);
    assert.equal(manifest.metrics.cacheHitPct, temperature === 'cold' ? 0 : 100);
    if (temperature === 'warm') {
      cli([
        'export',
        '--bake',
        bake,
        '--out',
        join(root, 'hero-exports'),
        '--targets',
        'godot,aseprite,texturepacker,strips',
        '--json',
      ]);
    }
  }
  // A corrupt registry receipt must refuse before starting a new generation.
  const receiptPath = join(relocated, 'fixture-gen/1.0.0/receipt.json');
  const modelReceipt = await readFile(receiptPath);
  await writeFile(receiptPath, '{broken');
  try {
    const failure = cli([
      'gen',
      '--workspace',
      join(root, 'refused'),
      '--character',
      'refused',
      '--image',
      image,
      '--model',
      'fixture-gen',
      '--json',
    ], true);
    assert.equal(failure.code, 1);
    assert.match(failure.output, /receipt|JSON|corrupt/i);
    assert(
      !existsSync(join(root, 'refused/character.json')),
      'Corrupt installs cannot publish a character',
    );
  } finally {
    await writeFile(receiptPath, modelReceipt);
  }
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
  const prior = {};
  for (
    const path of globSync('bakes/**/*', { cwd: root, withFileTypes: true }).filter((entry) =>
      entry.isFile()
    ).map((entry) => join(entry.parentPath, entry.name))
  ) {
    prior[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  const addon = join(runtime, 'node_modules/webgpu/dist', `${process.platform}-${process.arch}`);
  for (const file of ['dawn.node', ...(process.platform === 'win32' ? ['vulkan-1.dll'] : [])]) {
    const path = join(addon, file);
    await rename(path, `${path}.missing`);
    try {
      const failure = cli(['doctor', '--json'], true);
      assert.equal(failure.code, 1, `Missing ${file} must fail the OS process`);
      assert.match(failure.output, /error|unavailable|false/);
    } finally {
      await rename(`${path}.missing`, path);
    }
  }
  if (process.platform === 'win32') {
    const temp = join(root, 'owner-temp');
    await mkdir(temp);
    const child = spawn(binary, [
      'bake',
      '--model',
      join(runtime, 'sample/asymmetric.glb'),
      '--character',
      'interrupted',
      '--out',
      join(root, 'interrupted'),
      '--style',
      'pixel',
      '--frames',
      '120',
      '--json',
    ], { cwd: root, env: { ...env, TEMP: temp, TMP: temp }, windowsHide: true });
    const closed = once(child, 'close');
    child.stdout.resume();
    child.stderr.resume();
    const deadline = performance.now() + 60_000;
    try {
      while (globSync('**/*.png', { cwd: temp }).length === 0) {
        assert(
          child.exitCode === null && performance.now() < deadline,
          'Owned bake never reached a rendered frame',
        );
        await new Promise((done) => setTimeout(done, 25));
      }
    } finally {
      child.kill();
    }
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Owned descendants retained stdout after launcher death')),
          5000,
        ).unref()
      ),
    ]);
    assert.equal(
      globSync('interrupted/**/manifest.json', { cwd: root }).length,
      0,
      'Interrupted bake cannot publish a manifest',
    );
    cli([
      'bake',
      '--model',
      join(runtime, 'sample/asymmetric.glb'),
      '--character',
      'retry',
      '--out',
      join(root, 'retry'),
      '--style',
      'pixel',
      '--frames',
      '1',
      '--json',
    ]);
  }
  for (const [path, hash] of Object.entries(prior)) {
    assert.equal(
      createHash('sha256').update(await readFile(path)).digest('hex'),
      hash,
      'Prior accepted bake survived failure and retry',
    );
  }
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
        ...(gpuArg === '--gpu'
          ? [
            'fresh owned Python/base environment',
            'relocated model root',
            'synthetic gen/pick/Track A rig',
            'core-retargeted preview clip',
            'cold/warm styled AOVs',
            'all four exporters',
            'corrupt receipt refusal',
            'missing native assets',
            'prior bake unchanged',
            ...(process.platform === 'win32' ? ['owner death after rendered frame', 'retry'] : []),
          ]
          : []),
      ],
      transcript,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Installed payload checks passed; retained at ${root}`);
