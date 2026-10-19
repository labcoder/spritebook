import { execFileSync } from 'node:child_process';

/**
 * Working-agreement check: new package code lands with tests (AGENTS.md).
 * Fails when packages/** source changes without any *_test.ts change in the
 * same range. Override for genuine exceptions with a `[no-tests]` token in a
 * commit message of the range, stating why.
 *
 *   node tools/ci/tests-required.ts --base origin/main
 */
const baseIdx = process.argv.slice(2).indexOf('--base');
const base = baseIdx >= 0 ? process.argv.slice(2)[baseIdx + 1] : 'origin/main';

async function git(...args: string[]): Promise<string> {
  return execFileSync('git', args, { encoding: 'utf8', windowsHide: true });
}

const changed = (await git('diff', '--name-only', `${base}...HEAD`)).split('\n')
  .filter(Boolean);
const srcChanged = changed.filter((f) => /^packages\/.+\.ts$/.test(f) && !f.endsWith('_test.ts'));
const testsChanged = changed.some((f) => f.endsWith('_test.ts'));
const override = /\[no-tests\]/.test(
  await git('log', '--format=%B', `${base}...HEAD`),
);

if (srcChanged.length > 0 && !testsChanged && !override) {
  console.error('tests-required: package source changed with no test changes:');
  for (const f of srcChanged) console.error(`  ${f}`);
  console.error(
    'add/extend tests, or justify with a [no-tests] commit trailer.',
  );
  process.exit(1);
}
console.log('tests-required: ok');
