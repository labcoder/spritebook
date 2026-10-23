import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assert, assertEquals } from '@std/assert';
import type { JobEvent, ToolEntry } from '@spritebook/schema';
import { loadTools, runToolJob, type ToolJobOptions } from './dist/tools.js';

const digest = (data: string) => createHash('sha256').update(data).digest('hex');
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-tools-'));
  const base = (await loadTools())[0];
  const tool: ToolEntry = {
    ...base,
    downloads: [{
      ...base.downloads[0],
      os: process.platform as 'win32' | 'linux' | 'darwin',
      arch: process.arch as 'x64' | 'arm64',
      archive: { ...base.downloads[0].archive, bytes: 7, sha256: digest('archive') },
      executableSha256: digest('executable'),
      requiredDiskBytes: 100,
    }],
  };
  let downloads = 0;
  const opts: ToolJobOptions = {
    action: 'install',
    root,
    tool,
    acceptLicense: true,
    diskFreeBytes: 1000,
    fetcher: async (_url, dest, progress) => {
      downloads++;
      await fs.writeFile(dest, 'archive');
      progress?.(7);
    },
    probe: async () => base.version,
    unpack: async (_archive, dest) => {
      const app = join(dest, tool.downloads[0].prefix);
      await fs.mkdir(app);
      await fs.writeFile(join(app, tool.downloads[0].executable), 'executable');
      await fs.writeFile(join(app, 'copyright.txt'), 'license');
    },
  };
  return {
    root,
    opts,
    downloads: () => downloads,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
    run: (changes: Partial<ToolJobOptions> = {}): Promise<JobEvent[]> =>
      Array.fromAsync(runToolJob({ ...opts, ...changes })),
  };
}

test('tool install gates consent, disk and platform before downloading', async () => {
  const f = await fixture();
  try {
    const cases: [Partial<ToolJobOptions>, string][] = [
      [{ acceptLicense: false }, 'license-acceptance-required'],
      [{ diskFreeBytes: 99 }, 'disk-insufficient'],
      [{ tool: { ...f.opts.tool!, downloads: [] } }, 'platform-unsupported'],
    ];
    for (const [changes, code] of cases) {
      const events = await f.run(changes);
      assertEquals(events.at(-1)?.t, 'error');
      assertEquals((events.at(-1) as Extract<JobEvent, { t: 'error' }>).code, code);
    }
    assertEquals(f.downloads(), 0);
    assertEquals(await fs.readdir(f.root), ['blender.lock']);
  } finally {
    await f.cleanup();
  }
});

test('managed tool receipt verifies every extracted file and removes only owned data', async () => {
  const f = await fixture();
  try {
    const events = await f.run();
    assertEquals(events.at(-1)?.t, 'done');
    assert(events.some((e) => e.t === 'progress' && e.step.startsWith('download-bytes:')));
    const info = JSON.parse(await fs.readFile(join(f.root, 'blender.json'), 'utf8'));
    assertEquals(info.files.length, 2);
    assertEquals((await f.run({ action: 'verify' })).at(-1)?.t, 'done');
    const license = join(f.root, 'blender', info.version, 'app', 'copyright.txt');
    await fs.writeFile(license, 'changed');
    const broken = await f.run({ action: 'verify' });
    assertEquals((broken.at(-1) as Extract<JobEvent, { t: 'error' }>).code, 'tool-verify-failed');
    const userFile = join(f.root, 'my-other-tool');
    await fs.writeFile(userFile, 'keep');
    assertEquals((await f.run({ action: 'rm' })).at(-1)?.t, 'done');
    assertEquals(await fs.readFile(userFile, 'utf8'), 'keep');
    assertEquals(await fs.readdir(join(f.root, 'blender')), []);
    assertEquals(await fs.stat(join(f.root, 'blender.json')).catch(() => null), null);
  } finally {
    await f.cleanup();
  }
});

test('external registration failure preserves previous choice; unregister preserves the program', async () => {
  const f = await fixture();
  try {
    const external = join(f.root, 'user-blender');
    await fs.writeFile(external, 'user-owned executable');
    assertEquals((await f.run({ action: 'use', path: external })).at(-1)?.t, 'done');
    const old = await fs.readFile(join(f.root, 'blender.json'), 'utf8');
    assertEquals(
      (await f.run({
        action: 'use',
        path: external,
        probe: async () => {
          throw new Error('broken Blender');
        },
      })).at(-1)?.t,
      'error',
    );
    assertEquals(await fs.readFile(join(f.root, 'blender.json'), 'utf8'), old);
    assertEquals((await f.run({ action: 'rm' })).at(-1)?.t, 'done');
    assertEquals(await fs.readFile(external, 'utf8'), 'user-owned executable');
  } finally {
    await f.cleanup();
  }
});

test('bad archives and failed probes clean staging without replacing the selected tool', async () => {
  const f = await fixture();
  try {
    const external = join(f.root, 'user-blender');
    await fs.writeFile(external, 'user-owned');
    await f.run({ action: 'use', path: external });
    const old = await fs.readFile(join(f.root, 'blender.json'), 'utf8');
    const bad = await f.run({
      fetcher: async (_url, dest) => {
        await fs.writeFile(dest, 'corrupt');
      },
    });
    assertEquals((bad.at(-1) as Extract<JobEvent, { t: 'error' }>).code, 'hash-mismatch');
    assertEquals(
      (await f.run({
        probe: async () => {
          throw new Error('probe failed');
        },
      })).at(-1)?.t,
      'error',
    );
    assertEquals(await fs.readdir(join(f.root, 'blender')), []);
    assertEquals(await fs.readFile(join(f.root, 'blender.json'), 'utf8'), old);
  } finally {
    await f.cleanup();
  }
});

test('removing a downloaded copy preserves a separately selected external install', async () => {
  const f = await fixture();
  try {
    await f.run();
    const external = join(f.root, 'user-blender');
    await fs.writeFile(external, 'user-owned');
    await f.run({ action: 'use', path: external });
    const selected = await fs.readFile(join(f.root, 'blender.json'), 'utf8');
    assertEquals((await f.run({ action: 'rm', version: f.opts.tool!.version })).at(-1)?.t, 'done');
    assertEquals(await fs.readFile(join(f.root, 'blender.json'), 'utf8'), selected);
    assertEquals(await fs.readFile(external, 'utf8'), 'user-owned');
  } finally {
    await f.cleanup();
  }
});

test('managed removal refuses a junction or symlink into an unrelated installation', async () => {
  const f = await fixture();
  const outside = await fs.mkdtemp(join(tmpdir(), 'spritebook-user-tool-'));
  try {
    await f.run();
    const version = f.opts.tool!.version;
    const dir = join(f.root, 'blender', version);
    // Retain the original receipt paths while redirecting the version directory.
    await fs.rename(dir, join(outside, 'install'));
    await fs.symlink(
      join(outside, 'install'),
      dir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const events = await f.run({ action: 'rm' });
    assertEquals((events.at(-1) as Extract<JobEvent, { t: 'error' }>).code, 'tool-path-invalid');
    assertEquals(
      await fs.readFile(join(outside, 'install', 'app', 'copyright.txt'), 'utf8'),
      'license',
    );
  } finally {
    await f.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('invalid selection can be forgotten or replaced without following its paths', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(join(f.root, 'blender.json'), '{invalid');
    assertEquals((await f.run({ action: 'rm' })).at(-1)?.t, 'done');
    assertEquals(await fs.stat(join(f.root, 'blender.json')).catch(() => null), null);
    await fs.writeFile(join(f.root, 'blender.json'), '{invalid');
    const external = join(f.root, 'user-blender');
    await fs.writeFile(external, 'user-owned');
    assertEquals((await f.run({ action: 'use', path: external })).at(-1)?.t, 'done');
    assertEquals(
      JSON.parse(await fs.readFile(join(f.root, 'blender.json'), 'utf8')).mode,
      'external',
    );
    assertEquals(await fs.readFile(external, 'utf8'), 'user-owned');
  } finally {
    await f.cleanup();
  }
});
