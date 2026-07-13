/**
 * Conventional-commit lint, dependency-free (working agreement, AGENTS.md).
 *
 *   deno run --allow-read tools/ci/commit-lint.ts --file .git/COMMIT_EDITMSG
 *   deno run --allow-run tools/ci/commit-lint.ts --range origin/main..HEAD
 */
const TYPES = ['feat', 'fix', 'docs', 'chore', 'test', 'refactor', 'perf', 'ci', 'build', 'style'];
const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9-]+\\))?!?: .+`);

function checkMessage(msg: string): string | null {
  const header = msg.split('\n', 1)[0].trim();
  if (header.length === 0) return 'empty commit message';
  // merges and reverts are allowed as-is
  if (/^(Merge|Revert)\b/.test(header)) return null;
  if (!HEADER.test(header)) {
    return `not a conventional commit header: "${header}"\n` +
      `  expected: <type>(<scope>)?: <subject>  with type in {${TYPES.join(', ')}}`;
  }
  if (header.length > 72) return `header exceeds 72 chars (${header.length}): "${header}"`;
  return null;
}

const args = [...Deno.args];
let failures = 0;

if (args[0] === '--file') {
  const msg = await Deno.readTextFile(args[1]);
  const err = checkMessage(msg);
  if (err) {
    console.error(`commit-lint: ${err}`);
    failures++;
  }
} else if (args[0] === '--range') {
  const out = await new Deno.Command('git', {
    args: ['log', '--format=%H%x00%B%x01', args[1]],
    stdout: 'piped',
  }).output();
  const raw = new TextDecoder().decode(out.stdout);
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
  console.error('usage: commit-lint.ts --file <path> | --range <a>..<b>');
  Deno.exit(2);
}

if (failures > 0) Deno.exit(1);
console.log('commit-lint: ok');
