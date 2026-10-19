import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installVulkan } from '../setup-gpu.mjs';
import { publishRuntime, recoverRuntime } from './publish.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const build = resolve(repo, '.build');
const out = join(build, 'runtime');
const pins = JSON.parse(await readFile(new URL('./downloads.json', import.meta.url), 'utf8'));
const target = `${process.platform}-${process.arch}`;
const pin = pins.targets[target];
assert(pin, `No owned runtime recipe for ${target}`);
assert(process.env.npm_execpath, 'Run through npm run build:runtime');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exe = (name) => name + (process.platform === 'win32' ? '.exe' : '');
const copy = async (from, to) => {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, dereference: true });
};
const json = (value) => JSON.stringify(value, null, 2) + '\n';

async function download(pin) {
  const path = join(build, 'downloads', basename(new URL(pin.url).pathname));
  await mkdir(dirname(path), { recursive: true });
  let bytes = await readFile(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!bytes) {
    const response = await fetch(pin.url);
    assert(response.ok, `Download ${pin.url}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha(bytes), pin.sha256, `Download checksum: ${pin.url}`);
    await writeFile(path, bytes);
  }
  assert.equal(sha(bytes), pin.sha256, `Cached download checksum: ${path}`);
  return path;
}

async function files(dir, prefix = '') {
  const list = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    assert(!entry.isSymbolicLink(), `Runtime cannot depend on a checkout symlink: ${path}`);
    if (entry.isDirectory()) list.push(...await files(join(dir, entry.name), path));
    else list.push(path);
  }
  return list.sort();
}

// Only generated siblings under .build are replaced; a failed build leaves the last payload intact.
async function removeGenerated(path) {
  assert.equal(dirname(path), build);
  assert(basename(path).startsWith('runtime-'));
  await rm(path, { recursive: true, force: true });
}

await mkdir(build, { recursive: true });
await recoverRuntime(out);
const stage = await mkdtemp(join(build, 'runtime-stage-'));
const temp = await mkdtemp(join(build, 'runtime-input-'));
try {
  for (const kind of ['node', 'uv']) {
    const archive = await download(pin[kind]);
    const unpack = join(temp, kind);
    await mkdir(unpack);
    execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', unpack], {
      windowsHide: true,
    });
    const archiveRoot = basename(archive).replace(/\.(?:zip|tar\.gz)$/, '');
    const binary = kind === 'node'
      ? join(unpack, archiveRoot, process.platform === 'win32' ? 'node.exe' : 'bin/node')
      : process.platform === 'win32'
      ? join(unpack, 'uv.exe')
      : join(unpack, archiveRoot, 'uv');
    await copy(binary, join(stage, exe(kind)));
    await chmod(join(stage, exe(kind)), 0o755);
    if (kind === 'node') {
      await copy(join(unpack, archiveRoot, 'LICENSE'), join(stage, 'notices/Node-LICENSE'));
    }
  }
  for (const [name, pin] of Object.entries(pins.uvNotices)) {
    await copy(await download(pin), join(stage, `notices/uv-${name}`));
  }
  if (process.platform === 'win32') {
    // Dawn's ANSI loader needs a process-local UTF-8 code page, including Unicode install paths.
    const mt = process.env.SPRITEBOOK_MT_EXE ??
      join(process.env['ProgramFiles(x86)'], 'Windows Kits/10/bin/10.0.26100.0/x64/mt.exe');
    const node = join(stage, exe('node'));
    const manifest = join(temp, 'node.manifest');
    execFileSync(mt, ['-nologo', `-inputresource:${node};#1`, `-out:${manifest}`]);
    execFileSync(mt, [
      '-nologo',
      '-manifest',
      manifest,
      fileURLToPath(new URL('./utf8.manifest', import.meta.url)),
      `-outputresource:${node};#1`,
    ]);
    const merged = join(stage, 'notices/Node-runtime.manifest.xml');
    execFileSync(mt, ['-nologo', `-inputresource:${node};#1`, `-out:${merged}`]);
    assert((await readFile(merged, 'utf8')).includes('UTF-8</activeCodePage>'));
  }

  const graph = JSON.parse(
    execFileSync(process.execPath, [
      process.env.npm_execpath,
      'ls',
      '--workspace',
      '@spritebook/cli',
      '--omit=dev',
      '--all',
      '--json',
      '--long',
    ], { cwd: repo, encoding: 'utf8', maxBuffer: 20e6, windowsHide: true }),
  );
  const packages = new Map();
  function visit(node, name) {
    if (name && node.path) packages.set(node.path, name);
    for (const [key, dep] of Object.entries(node.dependencies ?? {})) visit(dep, key);
  }
  visit(graph);
  const inventory = [];
  for (const [source, name] of packages) {
    const destination = relative(repo, source);
    assert(
      destination.startsWith(`node_modules${sep}`) && !destination.includes(`..${sep}`),
      `Dependency outside production tree: ${source}`,
    );
    const to = join(stage, destination);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const own = name.startsWith('@spritebook/') || name === 'ndarray-pixels';
    if (own) {
      await mkdir(join(to, 'dist'), { recursive: true });
      await copy(join(source, 'package.json'), join(to, 'package.json'));
      for (const path of await readdir(join(source, 'dist'))) {
        if (path.endsWith('.js') && !path.includes('_test') && !path.startsWith('_')) {
          await copy(join(source, 'dist', path), join(to, 'dist', path));
        }
      }
    } else if (name === 'webgpu') {
      for (const path of ['package.json', 'index.js', 'LICENSE.md', `dist/${target}/dawn.node`]) {
        await copy(join(source, path), join(to, path));
      }
      if (process.platform === 'win32') await installVulkan(join(to, 'dist', target));
    } else {
      await cp(source, to, {
        recursive: true,
        dereference: true,
        filter: (path) => {
          const parts = relative(source, path).split(sep);
          return !parts.some((part) => /^(?:node_modules|tests?|__tests__|\.git)$/.test(part)) &&
            !/\.(?:tsx?|map)$/.test(path);
        },
      });
    }
    inventory.push({
      name,
      version: manifest.version,
      license: own ? 'AGPL-3.0-only' : manifest.license,
      path: destination.replaceAll('\\', '/'),
    });
  }
  for (
    const [name, paths] of [
      ['registry', ['catalog']],
      ['render', ['shaders.wgsl']],
      ['anim', ['packs']],
      ['rig', ['bodies']],
      ['core', [exe('spritebook-lock')]],
    ]
  ) {
    for (const path of paths) {
      await copy(join(repo, 'packages', name, 'dist', path), join(stage, 'assets', name, path));
    }
  }
  for (
    const path of [
      'pyproject.toml',
      'uv.lock',
      '.python-version',
      'spritebook_sidecar',
      'fetch_wheels.py',
      'wheels/wheels.lock.json',
      'README.md',
    ]
  ) {
    await cp(join(repo, 'sidecar', path), join(stage, 'assets/sidecar', path), {
      recursive: true,
      filter: (path) => !path.includes('__pycache__') && !path.endsWith('.pyc'),
    });
  }
  await copy(join(repo, 'packages/core/dist', exe('spritebook')), join(stage, exe('spritebook')));
  await chmod(join(stage, exe('spritebook')), 0o755);
  await mkdir(join(stage, 'core'));
  await writeFile(
    join(stage, 'core/cli.mjs'),
    "import '../node_modules/@spritebook/cli/dist/entry.js';\n",
  );
  for (const name of ['LICENSE', 'NOTICE']) await copy(join(repo, name), join(stage, name));
  for (
    const [from, to] of [
      ['docs/quickstart.md', 'quickstart.md'],
      ['CHANGELOG.md', 'CHANGELOG.md'],
      ['packages/style/fixtures/asymmetric.glb', 'sample/asymmetric.glb'],
    ]
  ) await copy(join(repo, from), join(stage, to));
  await writeFile(join(stage, 'notices/packages.json'), json(inventory));
  const versions = execFileSync(join(stage, exe('spritebook')), ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  assert.match(versions, /^spritebook \d+\.\d+\.\d+$/);
  const hashes = {};
  for (const path of await files(stage)) {
    assert(!/\.(?:tsx?|map)$/.test(path), `Development file in payload: ${path}`);
    assert(!/(?:dxcompiler|dxil|d3dcompiler).*\.dll$/i.test(path), `Uncleared shader DLL: ${path}`);
    hashes[path.replaceAll('\\', '/')] = sha(await readFile(join(stage, path)));
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  await writeFile(
    join(stage, 'receipt.json'),
    json({
      format: 1,
      target,
      node: pins.nodeVersion,
      uv: pins.uvVersion,
      version: versions,
      sourceCommit: commit,
      sourceDirty:
        execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()
          .length > 0,
      lockSha256: sha(await readFile(join(repo, 'package-lock.json'))),
      files: hashes,
    }),
  );
  await publishRuntime(stage, out);
  console.log(
    `${versions}: ${
      Object.keys(hashes).length
    } sealed files, ${packages.size} production packages -> ${out}`,
  );
} finally {
  await removeGenerated(stage);
  await removeGenerated(temp);
}
