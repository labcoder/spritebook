/** Kill our own installer during a local fixture download; retry without touching installed tools. */
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTools, runToolJob, type ToolJobOptions } from '@spritebook/registry';

const root = resolve(process.argv[2]);
const blocked = process.argv.includes('--block');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const tool = (await loadTools())[0];
const version = tool.version;
const options: ToolJobOptions = {
  action: 'install',
  root,
  acceptLicense: true,
  diskFreeBytes: 1000,
  tool: {
    ...tool,
    downloads: [{
      ...tool.downloads[0],
      os: process.platform as 'win32' | 'darwin' | 'linux',
      arch: process.arch as 'x64' | 'arm64',
      archive: { ...tool.downloads[0].archive, bytes: 7, sha256: hash('archive') },
      executableSha256: hash('executable'),
      requiredDiskBytes: 100,
    }],
  },
  probe: async () => version,
  fetcher: async (_url, destination) => {
    await fs.writeFile(destination, blocked ? 'partial' : 'archive');
    if (blocked) {
      console.log('STAGE_READY');
      await new Promise(() => setInterval(() => {}, 1000));
    }
  },
  unpack: async (_archive, destination) => {
    const app = join(destination, tool.downloads[0].prefix);
    await fs.mkdir(app);
    await fs.writeFile(join(app, tool.downloads[0].executable), 'executable');
  },
};
if (blocked) {
  for await (const event of runToolJob(options)) {
    if (event.t === 'error') throw new Error(event.message);
  }
} else {
  await fs.mkdir(root);
  const external = join(root, 'user-owned-program');
  await fs.writeFile(external, 'keep');
  const select = await Array.fromAsync(runToolJob({ ...options, action: 'use', path: external }));
  assert.equal(select.at(-1)?.t, 'done');
  const previous = await fs.readFile(join(root, 'blender.json'));
  const child = spawn(process.execPath, [
    resolve('tools/run.mjs'),
    fileURLToPath(import.meta.url),
    root,
    '--block',
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  try {
    let output = '';
    const ready = new Promise<void>((accept, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('STAGE_READY')) accept();
      });
      child.stderr.on('data', (chunk) => output += chunk);
      child.once('error', reject);
      closed.then(() => reject(new Error(`Installer exited before staging: ${output}`)));
    });
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Installer never reached staging')), 30000);
        timer.unref();
      }),
    ]);
    child.kill();
    await closed;
    assert.deepEqual(await fs.readFile(join(root, 'blender.json')), previous);
    const abandoned = (await fs.readdir(join(root, 'blender'))).filter((name) =>
      name.startsWith('.staging-')
    );
    assert.equal(abandoned.length, 1, 'The killed process leaves genuine interrupted staging');
    const events = await Array.fromAsync(runToolJob(options));
    assert.equal(events.at(-1)?.t, 'done', JSON.stringify(events));
    assert(
      (await fs.readdir(join(root, 'blender'))).every((name) => !name.startsWith('.staging-')),
    );
    assert.equal(await fs.readFile(external, 'utf8'), 'keep');
    assert.equal(
      (await Array.fromAsync(runToolJob({ ...options, action: 'verify' }))).at(-1)?.t,
      'done',
    );
    await fs.writeFile(
      join(root, 'report.json'),
      JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          killedDuringDownload: true,
          previousSelectionPreserved: true,
          retryCleanedOwnedStage: true,
          externalProgramPreserved: true,
          verifiedFixtureInstall: true,
          realBlenderDownload: false,
        },
        null,
        2,
      ),
    );
    console.log('RECOVERY PASS', root);
  } finally {
    child.kill();
    await closed;
  }
}
