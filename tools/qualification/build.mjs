import { strict as assert } from 'node:assert';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This first artifact is deliberately Windows x64 only. Other targets need native runs.
assert(process.platform === 'win32' && process.arch === 'x64', 'unqualified build target');
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const [outArg, workspaceArg] = process.argv.slice(2);
assert(outArg && workspaceArg, 'usage: node build.mjs <new-output> <F0-workspace-copy-source>');
const out = resolve(outArg);
const workspace = resolve(workspaceArg);
await mkdir(out); // Refuse existing artifacts; never overwrite a control or failed run.
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const copy = async (source, target) => {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
};
const nodeVersion = '24.22.0';
const nodeZipSha256 = 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3';
const download = await fetch(
  `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`,
);
assert(download.ok, `Node download: HTTP ${download.status}`);
const zip = new Uint8Array(await download.arrayBuffer());
assert.equal(sha(zip), nodeZipSha256, 'Node release archive checksum');
await writeFile(`${out}/node.zip`, zip);
await mkdir(`${out}/node-dist`);
execFileSync('tar.exe', ['-xf', `${out}/node.zip`, '-C', `${out}/node-dist`]);
const payload = `${out}/runtime`;
await mkdir(payload);
const nodeDist = `${out}/node-dist/node-v${nodeVersion}-win-x64`;
await copy(`${nodeDist}/node.exe`, `${payload}/node.exe`);
await copy(`${nodeDist}/LICENSE`, `${payload}/notices/Node-LICENSE`);
const pngMap = `${out}/png-import-map.json`;
const imports = {};
const scopes = {};
const rootConfig = JSON.parse(await readFile(`${repo}/deno.json`, 'utf8'));
for (const member of rootConfig.workspace) {
  const config = JSON.parse(await readFile(`${repo}/${member}/deno.json`, 'utf8'));
  assert.equal(typeof config.exports, 'string');
  imports[config.name] = pathToFileURL(resolve(repo, member, config.exports)).href;
  scopes[pathToFileURL(resolve(repo, member) + '/').href] = {
    ...config.imports,
    'fast-png': pathToFileURL(`${here}/png.ts`).href,
  };
}
imports['fast-png'] = pathToFileURL(`${here}/png.ts`).href;
await writeFile(
  pngMap,
  JSON.stringify({ imports, scopes }),
);
for (const entry of ['control-workload', 'workload', 'checks', 'loss']) {
  await mkdir(`${payload}/core`, { recursive: true });
  execFileSync('deno', [
    'bundle',
    ...(entry === 'control-workload' ? ['--config', `${repo}/deno.json`] : [
      '--no-config',
      '--node-modules-dir=manual',
      '--lock',
      `${repo}/deno.lock`,
      '--import-map',
      pngMap,
    ]),
    '--frozen',
    '--output',
    `${payload}/core/${entry}.mjs`,
    `${here}/${entry === 'control-workload' ? 'workload' : entry}.ts`,
  ], { cwd: repo, stdio: 'inherit' });
  if (entry !== 'control-workload') {
    assert(
      (await readFile(`${payload}/core/${entry}.mjs`, 'utf8')).includes('F2 PNG adapter accepts'),
    );
  }
}
for (const name of ['node-run.mjs', 'node-environment.mjs']) {
  await copy(`${here}/${name}`, `${payload}/${name}`);
}
const addon = `${here}/node_modules/webgpu`;
assert.equal(JSON.parse(await readFile(`${addon}/package.json`, 'utf8')).version, '0.6.2');
for (const name of ['index.js', 'LICENSE.md']) {
  await copy(`${addon}/${name}`, `${payload}/vendor/webgpu/${name}`);
}
await writeFile(`${payload}/vendor/webgpu/package.json`, '{"type":"module"}\n');
// Vulkan does not need Microsoft's FXC or DXC DLLs. Do not silently redistribute them.
await copy(
  `${addon}/dist/win32-x64/dawn.node`,
  `${payload}/vendor/webgpu/dist/win32-x64/dawn.node`,
);
const vulkanVersion = '1.4.341.0';
const vulkanZipSha256 = '20571dcc8292b80a47d68bbbfa4094d87044041f50f4e2e1f326a01e3732b226';
const vulkanDownload = await fetch(
  `https://sdk.lunarg.com/sdk/download/${vulkanVersion}/windows/VulkanRT-X64-${vulkanVersion}-Components.zip?Human=true`,
);
assert(vulkanDownload.ok, `Vulkan loader download: HTTP ${vulkanDownload.status}`);
const vulkanZip = new Uint8Array(await vulkanDownload.arrayBuffer());
assert.equal(sha(vulkanZip), vulkanZipSha256, 'Vulkan release archive checksum');
await writeFile(`${out}/vulkan.zip`, vulkanZip);
await mkdir(`${out}/vulkan-dist`);
execFileSync('tar.exe', ['-xf', `${out}/vulkan.zip`, '-C', `${out}/vulkan-dist`]);
const vulkanDist = `${out}/vulkan-dist/VulkanRT-X64-${vulkanVersion}-Components`;
await copy(
  `${vulkanDist}/x64/vulkan-1.dll`,
  `${payload}/vendor/webgpu/dist/win32-x64/vulkan-1.dll`,
);
await copy(`${vulkanDist}/VulkanRT-License.txt`, `${payload}/notices/VulkanRT-License.txt`);
await copy(`${repo}/packages/render/shaders.wgsl`, `${payload}/core/shaders.wgsl`);
await copy(
  `${repo}/packages/render/fixtures/skinned-column.glb`,
  `${payload}/core/fixtures/skinned-column.glb`,
);
for (const name of ['aov', 'goldens', 'asymmetric.glb']) {
  await copy(`${repo}/packages/style/fixtures/${name}`, `${payload}/core/fixtures/${name}`);
}
await copy(
  `${repo}/packages/style/fixtures/asymmetric.glb`,
  `${payload}/style/fixtures/asymmetric.glb`,
);
for (const name of await readdir(`${repo}/packages/anim/fixtures`)) {
  if (name.endsWith('.glb')) {
    await copy(`${repo}/packages/anim/fixtures/${name}`, `${payload}/core/fixtures/${name}`);
  }
}
await copy(
  `${repo}/packages/rig/bodies/ubc-male/body.glb`,
  `${payload}/rig/bodies/ubc-male/body.glb`,
);
const pack = `${repo}/packages/anim/packs/ual`;
// These are the only clips read by the workload and original attachment assertions.
const clipIds = ['idle-loop', 'walk-loop', 'punch-jab', 'a-tpose', 'sword-attack'];
const packManifest = JSON.parse(await readFile(`${pack}/pack.json`, 'utf8'));
packManifest.clips = packManifest.clips.filter((clip) => clipIds.includes(clip.id));
assert.equal(packManifest.clips.length, clipIds.length);
await mkdir(`${payload}/anim/packs/ual/clips`, { recursive: true });
await writeFile(`${payload}/anim/packs/ual/pack.json`, JSON.stringify(packManifest) + '\n');
for (const id of clipIds) {
  await copy(`${pack}/clips/${id}.glb`, `${payload}/anim/packs/ual/clips/${id}.glb`);
}
await copy(`${workspace}/canonical/model.glb`, `${payload}/assets/model.glb`);
const character = JSON.parse(await readFile(`${workspace}/character.json`, 'utf8'));
await writeFile(`${payload}/assets/look.json`, JSON.stringify(character.look) + '\n');
await copy(`${repo}/LICENSE`, `${payload}/notices/SpriteBook-LICENSE`);
await copy(`${repo}/NOTICE`, `${payload}/notices/SpriteBook-NOTICE`);
const npmPackages = new Set();
for (const entry of ['control-workload', 'workload', 'checks', 'loss']) {
  const bundle = await readFile(`${payload}/core/${entry}.mjs`, 'utf8');
  for (
    const match of bundle.matchAll(
      /^\/\/ node_modules\/\.deno\/([^/]+\/node_modules\/(?:@[^/]+\/)?[^/]+)/gm,
    )
  ) {
    npmPackages.add(match[1]);
  }
}
const npmNotices = [];
for (const path of [...npmPackages].sort()) {
  const dir = `${repo}/node_modules/.deno/${path}`;
  const metadata = JSON.parse(await readFile(`${dir}/package.json`, 'utf8'));
  const notices = (await readdir(dir)).filter((name) =>
    /^(licen[sc]e|notice|copying)(\.|$)/i.test(name)
  );
  assert(notices.length, `No license file for bundled ${metadata.name}`);
  for (const name of notices) {
    await copy(`${dir}/${name}`, `${payload}/notices/npm/${metadata.name}/${name}`);
  }
  npmNotices.push({ name: metadata.name, version: metadata.version, license: metadata.license });
}
await writeFile(`${payload}/notices/npm.json`, JSON.stringify(npmNotices, null, 2) + '\n');
const stdLicense = await fetch(
  'https://raw.githubusercontent.com/denoland/std/808fe203e0ce4da730880ad270179fdaa1f6fc7d/LICENSE',
);
assert(stdLicense.ok, `Standard-library license: HTTP ${stdLicense.status}`);
const stdLicenseBytes = new Uint8Array(await stdLicense.arrayBuffer());
assert.equal(
  sha(stdLicenseBytes),
  '0961f97da6619d5fe9ddb98649191d5ca6e958856ea5252f4cce7c9b85513819',
);
await writeFile(`${payload}/notices/deno-std-LICENSE`, stdLicenseBytes);
await writeFile(
  `${out}/tauri.conf.json`,
  JSON.stringify(
    {
      productName: 'SpriteBook Renderer Proof',
      identifier: 'dev.spritebook.rendererproof',
      build: { beforeBuildCommand: null, frontendDist: `${here}/frontend` },
      app: { windows: [] },
      bundle: {
        resources: { [`${payload}/`]: 'renderer-runtime/' },
        windows: { webviewInstallMode: { type: 'skip' } },
      },
    },
    null,
    2,
  ) + '\n',
);
// The receipt seals inputs/binaries; it is evidence, never an application cache key.
const files = {};
async function seal(dir, prefix = '') {
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) await seal(path, `${prefix}${name}/`);
    else files[`${prefix}${name}`] = sha(await readFile(path));
  }
}
await seal(payload);
await writeFile(
  `${out}/build.json`,
  JSON.stringify(
    {
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' })
        .trim(),
      sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }),
      nodeVersion,
      nodeZipSha256,
      vulkanVersion,
      vulkanZipSha256,
      webgpuVersion: '0.6.2',
      files,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Proof runtime: ${payload}`);
