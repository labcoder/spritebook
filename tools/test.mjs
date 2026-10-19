import { strict as assert } from 'node:assert';
import { globSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const requested = process.argv.slice(2);
const flags = new Set(requested.filter((arg) => arg.startsWith('--')));
for (const flag of flags) {
  assert(
    ['--gpu', '--real', '--coverage'].includes(flag),
    `Unknown flag ${flag}`,
  );
}
if (flags.has('--gpu') || flags.has('--real')) {
  process.env.SPRITEBOOK_REQUIRE_GPU = '1';
}
if (flags.has('--real')) process.env.SPRITEBOOK_REAL_BACKENDS = '1';
const selected = requested.filter((arg) => !arg.startsWith('--'));
const scopes = selected.length ? selected : ['packages', 'apps/studio', 'tools'];
const files = new Set();
for (const scope of scopes) {
  const found = globSync(
    scope.endsWith('_test.ts') ? scope : `${scope}/**/*_test.ts`,
    {
      cwd: root,
      exclude: ['**/node_modules/**', '**/dist/**', '**/target/**'],
    },
  );
  assert(found.length, `No tests matched ${scope}`);
  for (const file of found) files.add(file);
}
const options = [];
if (flags.has('--coverage')) {
  mkdirSync(`${root}/.coverage`, { recursive: true });
  options.push(
    '--experimental-test-coverage',
    '--test-coverage-include=packages/*/dist/*.js',
    '--test-reporter=spec',
    '--test-reporter=lcov',
    '--test-reporter-destination=stdout',
    '--test-reporter-destination=.coverage/lcov.info',
  );
}
const child = spawn(process.execPath, [
  '--import',
  './tools/testing/setup.ts',
  '--test',
  '--test-concurrency=1',
  `--test-timeout=${process.env.SPRITEBOOK_REAL_BACKENDS ? 3_600_000 : 120_000}`,
  ...options,
  ...[...files].sort(),
], { cwd: root, stdio: 'inherit', windowsHide: true });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    child.kill();
  });
}
const [code, signal] = await once(child, 'close');
assert.equal(signal, null, 'test runner terminated by a signal');
process.exitCode = code ?? 1;
