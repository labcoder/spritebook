/**
 * D-039 detection: the scan half against plain directory trees (a real
 * container cannot be simulated in a test), plus the orchestrator's
 * short-circuits and cleanup. The live verdict is deliberately never
 * asserted — it differs between a contained dev shell and CI.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  detectAppDataVirtualization,
  findMarkerBacking,
  rootUnderLocalAppData,
  virtualizationNote,
} from './virtualization.ts';

Deno.test('findMarkerBacking locates the physical copy and names the package', async () => {
  const local = await Deno.makeTempDir({ prefix: 'sb-vfs-' });
  try {
    const backing = `${local}/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Local`;
    await Deno.mkdir(backing, { recursive: true });
    await Deno.mkdir(`${local}/Packages/Other_pkg/LocalCache/Local`, { recursive: true });
    await Deno.writeTextFile(`${backing}/.sb-vfs-probe-x`, 'probe');
    const hit = await findMarkerBacking(local, '.sb-vfs-probe-x');
    assert(hit !== null);
    assertEquals(hit.pkg, 'Claude_pzs8sxrjxfjjc');
    assertEquals(hit.backing, `${backing}/.sb-vfs-probe-x`);
  } finally {
    await Deno.remove(local, { recursive: true });
  }
});

Deno.test('findMarkerBacking is null without a copy, or without Packages at all', async () => {
  const local = await Deno.makeTempDir({ prefix: 'sb-vfs-' });
  try {
    assertEquals(await findMarkerBacking(local, '.m'), null); // no Packages dir
    await Deno.mkdir(`${local}/Packages/Some_pkg/LocalCache/Local`, { recursive: true });
    assertEquals(await findMarkerBacking(local, '.m'), null); // no copy
  } finally {
    await Deno.remove(local, { recursive: true });
  }
});

Deno.test('detect short-circuits off windows and without LOCALAPPDATA', async () => {
  assertEquals(await detectAppDataVirtualization(() => '/x', 'linux'), { virtualized: false });
  assertEquals(await detectAppDataVirtualization(() => undefined, 'windows'), {
    virtualized: false,
  });
});

Deno.test('detect cleans its marker up and reads an unvirtualized tree as real', async () => {
  const local = await Deno.makeTempDir({ prefix: 'sb-vfs-' });
  try {
    const v = await detectAppDataVirtualization(() => local, 'windows');
    assertEquals(v, { virtualized: false });
    const leftovers = (await Array.fromAsync(Deno.readDir(local)))
      .filter((e) => e.name.startsWith('.sb-vfs-probe-'));
    assertEquals(leftovers, [], 'the probe marker never lingers');
  } finally {
    await Deno.remove(local, { recursive: true });
  }
});

Deno.test('virtualizationNote is silent when the view is real', async () => {
  const local = await Deno.makeTempDir({ prefix: 'sb-vfs-' });
  try {
    assertEquals(await virtualizationNote(() => local, 'windows'), '');
    assertEquals(await virtualizationNote(() => undefined, 'linux'), '');
  } finally {
    await Deno.remove(local, { recursive: true });
  }
});

Deno.test('rootUnderLocalAppData compares case- and separator-insensitively', () => {
  const env = () => 'C:\\Users\\x\\AppData\\Local';
  assert(rootUnderLocalAppData('C:/users/x/appdata/local/spritebook/models', env));
  assert(!rootUnderLocalAppData('C:/dev/models', env));
  assert(!rootUnderLocalAppData('C:/Users/x/AppData/Local', env), 'the root itself is not under');
  assert(!rootUnderLocalAppData('C:/x', () => undefined));
});
