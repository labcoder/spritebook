import { strict as assert } from 'node:assert';
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const requested = process.argv.slice(2);
const scopes = requested.length ? requested : ['packages', 'apps/studio', 'tools'];
const files = new Set();
for (const scope of scopes) {
  const found = globSync(scope.endsWith('_test.ts') ? scope : `${scope}/**/*_test.ts`, {
    cwd: root, exclude: ['**/node_modules/**', '**/dist/**', '**/target/**'],
  });
  assert(found.length, `No tests matched ${scope}`);
  for (const file of found) files.add(file);
}
const child = spawnSync(process.execPath, [
  '--import', './tools/testing/setup.ts', '--test', '--test-concurrency=1',
  `--test-timeout=${process.env.SPRITEBOOK_REAL_BACKENDS ? 3_600_000 : 120_000}`,
  ...[...files].sort(),
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (child.error) throw child.error;
assert.equal(child.signal, null, 'test runner terminated by a signal');
process.exitCode = child.status ?? 1;
