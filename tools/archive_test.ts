import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

test('archive extraction preserves bytes with spaces and a conflicting Windows tar on PATH', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sb-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input'), output = join(root, 'output');
  await mkdir(input);
  await mkdir(output);
  const bytes = Buffer.from('SpriteBook archive fixture\n');
  await writeFile(join(input, 'payload.txt'), bytes);
  const windows = process.platform === 'win32';
  const archive = join(root, `archive path.${windows ? 'zip' : 'tar.gz'}`);
  const env = { ...process.env };
  const nativeTar = windows ? join(process.env.SystemRoot!, 'System32/tar.exe') : 'tar';
  execFileSync(nativeTar, [
    ...(windows ? ['-a', '-cf'] : ['-czf']),
    archive,
    '-C',
    input,
    'payload.txt',
  ], { windowsHide: true });
  if (windows) {
    const shadow = join(root, 'shadow');
    await mkdir(shadow);
    await copyFile(join(process.env.SystemRoot!, 'System32/where.exe'), join(shadow, 'tar.exe'));
    env.PATH = `${shadow}${delimiter}${env.PATH ?? ''}`;
  }
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import { extractArchive } from ${JSON.stringify(new URL('./archive.ts', import.meta.url).href)};
    extractArchive(${JSON.stringify(archive)}, ${JSON.stringify(output)});
  `,
  ], { env, windowsHide: true });
  assert.deepEqual(await readFile(join(output, 'payload.txt')), bytes);
});
