import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
/**
 * Conventional-commit lint, dependency-free (working agreement, AGENTS.md).
 *
 *   node tools/ci/commit-lint.mjs --file .git/COMMIT_EDITMSG
 *   node tools/ci/commit-lint.mjs --range origin/main..HEAD
 */
const TYPES = [
  'feat',
  'fix',
  'docs',
  'chore',
  'test',
  'refactor',
  'perf',
  'ci',
  'build',
  'style',
];
const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9-]+\\))?!?: .+`);

function checkMessage(msg) {
  const header = msg.split('\n', 1)[0].trim();
  if (header.length === 0) return 'empty commit message';
  // merges and reverts are allowed as-is
  if (/^(Merge|Revert)\b/.test(header)) return null;
  if (!HEADER.test(header)) {
    return `not a conventional commit header: "${header}"\n` +
      `  expected: <type>(<scope>)?: <subject>  with type in {${TYPES.join(', ')}}`;
  }
  if (header.length > 72) {
    return `header exceeds 72 chars (${header.length}): "${header}"`;
  }
  return null;
}

const args = process.argv.slice(2);
let failures = 0;

if (args[0] === '--file') {
  const msg = await readFile(args[1], 'utf8');
  const err = checkMessage(msg);
  if (err) {
    console.error(`commit-lint: ${err}`);
    failures++;
  }
} else if (args[0] === '--range') {
  const raw = execFileSync('git', ['log', '--format=%H%x00%B%x01', args[1]], {
    encoding: 'utf8',
  });
  for (const entry of raw.split('\x01')) {
    const [hash, body] = entry.split('\x00');
    if (!body?.trim()) continue;
    const err = checkMessage(body);
    if (err) {
      console.error(`commit-lint: ${hash?.trim().slice(0, 7)}: ${err}`);
      failures++;
    }
  }
} else {
  console.error('usage: commit-lint.mjs --file <path> | --range <a>..<b>');
  process.exit(2);
}

if (failures > 0) process.exit(1);
console.log('commit-lint: ok');
