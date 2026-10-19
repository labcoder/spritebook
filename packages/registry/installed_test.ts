import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Installed layer: root resolution (env-injected, per-OS), the deterministic
 * numeric-aware version order, and the receipt-is-the-installed-marker law —
 * receiptless dirs and staging leftovers are invisible, corrupt receipts are
 * loud.
 */
import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { canonicalJson } from '@spritebook/schema';
import {
  compareVersions,
  defaultModelsRoot,
  getReceipt,
  listInstalled,
  RECEIPT_FILE,
  resolveInstalled,
} from './dist/installed.js';
import { plantReceipt } from './_testutil.ts';

test('defaultModelsRoot: env override wins; per-OS data dirs; honest when unset', () => {
  const env = (vars: Record<string, string>) => (key: string) => vars[key];
  assertEquals(
    defaultModelsRoot(env({ SPRITEBOOK_MODELS_DIR: 'D:/models' }), 'windows'),
    'D:/models',
  );
  assertEquals(
    defaultModelsRoot(env({ LOCALAPPDATA: 'C:/Users/First Last/AppData/Local' }), 'windows'),
    'C:/Users/First Last/AppData/Local/spritebook/models',
  );
  assertEquals(
    defaultModelsRoot(env({ HOME: '/Users/o' }), 'darwin'),
    '/Users/o/Library/Application Support/spritebook/models',
  );
  assertEquals(
    defaultModelsRoot(env({ HOME: '/home/o', XDG_DATA_HOME: '/data' }), 'linux'),
    '/data/spritebook/models',
  );
  assertEquals(
    defaultModelsRoot(env({ HOME: '/home/o' }), 'linux'),
    '/home/o/.local/share/spritebook/models',
  );
  assertThrows(() => defaultModelsRoot(env({}), 'windows'), Error, 'LOCALAPPDATA');
  assertThrows(() => defaultModelsRoot(env({}), 'linux'), Error, 'HOME');
});

test('compareVersions: numeric-aware, deterministic, antisymmetric', () => {
  const cases: [string, string, number][] = [
    ['1.2', '1.10', -1], // numeric, not lexicographic
    ['1.9', '2.0', -1],
    ['1.2', '1.2.1', -1], // shorter loses the tie
    ['1.2', '1.2', 0],
    ['1.10', '1.9b', -1], // numeric segment sorts before non-numeric
    ['1.2b', '1.2a', 1], // both non-numeric: plain string compare
  ];
  for (const [a, b, want] of cases) {
    assertEquals(Math.sign(compareVersions(a, b)), want, `${a} vs ${b}`);
    assertEquals(Math.sign(compareVersions(b, a)), -want, `${b} vs ${a} (antisymmetry)`);
  }
});

test('listInstalled/resolveInstalled: receipted versions only, highest wins', async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  const root = `${tmp}/models`;
  try {
    assertEquals(await listInstalled(root), [], 'missing root = nothing installed');
    await plantReceipt(root, 'toy-rig', '1.2');
    await plantReceipt(root, 'toy-rig', '1.10');
    await plantReceipt(root, 'a-model', '0.1');
    // crash-window remnant: weights without a receipt are NOT installed
    await fs.mkdir(`${root}/toy-rig/9.9`, { recursive: true });
    await fs.writeFile(`${root}/toy-rig/9.9/model.ckpt`, 'x');
    // a crashed staging dir must not break or pollute the listing
    await fs.mkdir(`${root}/.staging-toy-rig-1.0-dead`, { recursive: true });

    const got = await listInstalled(root);
    assertEquals(
      got.map((x) => `${x.id}@${x.version}`),
      ['a-model@0.1', 'toy-rig@1.2', 'toy-rig@1.10'],
    );
    assertEquals((await resolveInstalled(root, 'toy-rig'))?.version, '1.10', 'numeric-aware max');
    assertEquals((await resolveInstalled(root, 'toy-rig', '1.2'))?.version, '1.2');
    assertEquals(await resolveInstalled(root, 'toy-rig', '9.9'), null, 'receiptless = absent');
    assertEquals(await resolveInstalled(root, 'ghost'), null);
  } finally {
    await fs.rm(tmp, { recursive: true });
  }
});

test('getReceipt: corrupt receipts are loud, never a silent not-installed', async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  const root = `${tmp}/models`;
  try {
    assertEquals(await getReceipt(root, 'toy-rig', '1.0'), null, 'missing -> null');
    const dir = `${root}/toy-rig/1.0`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/${RECEIPT_FILE}`, '{broken');
    await assertRejects(() => getReceipt(root, 'toy-rig', '1.0'), Error, 'invalid JSON');
    await fs.writeFile(`${dir}/${RECEIPT_FILE}`, canonicalJson({ schemaVersion: 2 }));
    await assertRejects(() => getReceipt(root, 'toy-rig', '1.0'), Error, 'InstallReceipt');
  } finally {
    await fs.rm(tmp, { recursive: true });
  }
});
