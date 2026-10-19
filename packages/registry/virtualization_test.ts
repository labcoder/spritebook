import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * D-039 detection: the scan half against plain directory trees (a real
 * container cannot be simulated in a test), plus the orchestrator's
 * short-circuits and cleanup. The live verdict is deliberately never
 * asserted — it differs between a contained dev shell and CI.
 */
import { assert, assertEquals } from '@std/assert';
import {
  detectAppDataVirtualization,
  findMarkerBacking,
  rootUnderLocalAppData,
  virtualizationNote,
} from './dist/virtualization.js';

test('findMarkerBacking locates the physical copy and names the package', async () => {
  const local = await fs.mkdtemp(join(tmpdir(), 'sb-vfs-'));
  try {
    const backing = `${local}/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Local`;
    await fs.mkdir(backing, { recursive: true });
    await fs.mkdir(`${local}/Packages/Other_pkg/LocalCache/Local`, { recursive: true });
    await fs.writeFile(`${backing}/.sb-vfs-probe-x`, 'probe');
    const hit = await findMarkerBacking(local, '.sb-vfs-probe-x');
    assert(hit !== null);
    assertEquals(hit.pkg, 'Claude_pzs8sxrjxfjjc');
    assertEquals(hit.backing, `${backing}/.sb-vfs-probe-x`);
  } finally {
    await fs.rm(local, { recursive: true });
  }
});

test('findMarkerBacking is null without a copy, or without Packages at all', async () => {
  const local = await fs.mkdtemp(join(tmpdir(), 'sb-vfs-'));
  try {
    assertEquals(await findMarkerBacking(local, '.m'), null); // no Packages dir
    await fs.mkdir(`${local}/Packages/Some_pkg/LocalCache/Local`, { recursive: true });
    assertEquals(await findMarkerBacking(local, '.m'), null); // no copy
  } finally {
    await fs.rm(local, { recursive: true });
  }
});

test('detect short-circuits off windows and without LOCALAPPDATA', async () => {
  assertEquals(await detectAppDataVirtualization(() => '/x', 'linux'), { virtualized: false });
  assertEquals(await detectAppDataVirtualization(() => undefined, 'windows'), {
    virtualized: false,
  });
});

test('detect cleans its marker up and reads an unvirtualized tree as real', async () => {
  const local = await fs.mkdtemp(join(tmpdir(), 'sb-vfs-'));
  try {
    const v = await detectAppDataVirtualization(() => local, 'windows');
    assertEquals(v, { virtualized: false });
    const leftovers = (await fs.readdir(local, { withFileTypes: true }))
      .filter((e) => e.name.startsWith('.sb-vfs-probe-'));
    assertEquals(leftovers, [], 'the probe marker never lingers');
  } finally {
    await fs.rm(local, { recursive: true });
  }
});

test('virtualizationNote is silent when the view is real', async () => {
  const local = await fs.mkdtemp(join(tmpdir(), 'sb-vfs-'));
  try {
    assertEquals(await virtualizationNote(() => local, 'windows'), '');
    assertEquals(await virtualizationNote(() => undefined, 'linux'), '');
  } finally {
    await fs.rm(local, { recursive: true });
  }
});

test('rootUnderLocalAppData compares case- and separator-insensitively', () => {
  const env = () => 'C:\\Users\\x\\AppData\\Local';
  assert(rootUnderLocalAppData('C:/users/x/appdata/local/spritebook/models', env));
  assert(!rootUnderLocalAppData('C:/dev/models', env));
  assert(!rootUnderLocalAppData('C:/Users/x/AppData/Local', env), 'the root itself is not under');
  assert(!rootUnderLocalAppData('C:/x', () => undefined));
});
