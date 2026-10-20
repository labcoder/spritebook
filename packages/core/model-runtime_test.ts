import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertEquals, assertNotEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '@spritebook/schema';
import { modelRuntime, readModelRuntime } from './dist/model-runtime.js';

test('prepared runtime refuses incomplete/corrupt source and follows lock changes', async () => {
  const temp = await fs.mkdtemp(join(tmpdir(), 'spritebook-model-runtime-'));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = temp;
  let root: string | undefined;
  try {
    await fs.mkdir(join(temp, 'runtimes'));
    await fs.writeFile(join(temp, 'uv.lock'), 'first frozen environment');
    await fs.writeFile(join(temp, 'runtimes/unpack.py'), 'pass');
    await fs.writeFile(join(temp, 'runtimes/check.py'), 'pass');
    const id = `test-${crypto.randomUUID()}`;
    await fs.writeFile(
      join(temp, `runtimes/${id}.json`),
      JSON.stringify({
        id,
        platform: 'win32-x64',
        project: '.',
        check: 'runtimes/check.py',
        sources: [{
          url: 'https://example.invalid/source.zip',
          bytes: 1,
          sha256: 'a'.repeat(64),
          path: 'source',
          zip: true,
        }],
        environment: { SPRITEBOOK_TEST_CODE: 'source' },
        notes: 'Test-only owned source',
      }),
    );
    const info = await modelRuntime(id, temp);
    root = info.root;
    assertEquals(await readModelRuntime(info), undefined);
    await fs.mkdir(info.root, { recursive: true });
    await fs.writeFile(join(info.root, 'source.py'), 'verified source');
    const files = { 'source.py': createHash('sha256').update('verified source').digest('hex') };
    await fs.writeFile(
      join(info.root, 'ready.json'),
      canonicalJson({ fingerprint: info.fingerprint, preparedAt: new Date().toISOString(), files }),
    );
    await assertRejects(() => readModelRuntime(info), Error, 'environment is missing');
    await fs.mkdir(info.environment, { recursive: true });
    await fs.writeFile(join(info.environment, 'pyvenv.cfg'), 'home = owned Python');
    assertEquals((await readModelRuntime(info))?.files, files);
    await fs.writeFile(join(info.root, 'source.py'), 'changed source');
    await assertRejects(() => readModelRuntime(info), Error, 'source changed');
    await fs.writeFile(
      join(info.root, 'ready.json'),
      canonicalJson({
        fingerprint: info.fingerprint,
        preparedAt: new Date().toISOString(),
        files: { '../escape.py': 'a'.repeat(64) },
      }),
    );
    await assertRejects(() => readModelRuntime(info), Error, 'model runtime receipt');
    await fs.writeFile(join(temp, 'uv.lock'), 'new frozen environment');
    assertNotEquals((await modelRuntime(id, temp)).root, info.root);
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
