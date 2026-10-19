import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishRuntime, recoverRuntime } from './publish.ts';

test('runtime publication preserves the old payload after failure and interrupted replacement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sb-runtime-publish-'));
  t.after(() => rm(root, { recursive: true }));
  const out = join(root, 'runtime'), stage = join(root, 'runtime-stage-test');
  await mkdir(out);
  await writeFile(join(out, 'receipt.json'), 'previous');
  await assert.rejects(publishRuntime(stage, out), { code: 'ENOENT' });
  assert.equal(await readFile(join(out, 'receipt.json'), 'utf8'), 'previous');
  // This is the on-disk boundary left by process death after moving the old directory.
  await rename(out, `${out}-backup`);
  await recoverRuntime(out);
  assert.equal(await readFile(join(out, 'receipt.json'), 'utf8'), 'previous');
  await mkdir(stage);
  await writeFile(join(stage, 'receipt.json'), 'next');
  await publishRuntime(stage, out);
  assert.equal(await readFile(join(out, 'receipt.json'), 'utf8'), 'next');
  await assert.rejects(readFile(join(`${out}-backup`, 'receipt.json')), { code: 'ENOENT' });
});
