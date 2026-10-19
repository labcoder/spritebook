import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync('cargo', [
  'build',
  '--release',
  '--locked',
  '--manifest-path',
  'packages/core/native/Cargo.toml',
  '--target-dir',
  'packages/core/native/target',
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
assert.equal(result.status, 0, 'native ownership helper build');
await mkdir(`${root}/packages/core/dist`, { recursive: true });
for (const binary of ['spritebook-lock', 'spritebook']) {
  const name = `${binary}${process.platform === 'win32' ? '.exe' : ''}`;
  await copyFile(
    `${root}/packages/core/native/target/release/${name}`,
    `${root}/packages/core/dist/${name}`,
  );
}
