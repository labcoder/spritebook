/** Every new direct npm dependency needs a role/license row in the BOM. */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export function dependencyNames(text: string): string[] {
  const manifest = JSON.parse(text);
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]),
  ].filter((name) => !name.startsWith('@spritebook/'));
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', windowsHide: true });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'origin/main';
  git('rev-parse', '--verify', base);
  const manifestPath =
    /^(?:package\.json|packages\/[^/]+\/package\.json|apps\/studio\/package\.json)$/;
  const beforeFiles = git('ls-tree', '-r', '--name-only', base).split('\n');
  const before = new Set(
    beforeFiles.filter((path) => manifestPath.test(path))
      .flatMap((path) => dependencyNames(git('show', `${base}:${path}`))),
  );
  // The F4 migration range starts before the npm workspace existed.
  if (
    !beforeFiles.includes('package.json') && beforeFiles.includes('deno.lock')
  ) {
    for (
      const match of git('show', `${base}:deno.lock`).matchAll(
        /"(?:npm|jsr):((?:@[\w.-]+\/)?[\w.-]+)@/g,
      )
    ) {
      before.add(match[1]);
    }
  }
  const afterFiles = git('ls-files').split('\n').filter((path) => manifestPath.test(path));
  const after = new Set(
    (await Promise.all(
      afterFiles.map(async (path) => dependencyNames(await readFile(path, 'utf8'))),
    )).flat(),
  );
  const added = [...after].filter((name) => !before.has(name));
  const bom = (await readFile('docs/developer/dependencies.md', 'utf8')).toLowerCase();
  const missing = added.filter((name) =>
    !bom.includes(name.toLowerCase().replace(/^@[\w.-]+\//, ''))
  );
  if (missing.length) {
    console.error(
      `bom-guard: add role/license rows to docs/developer/dependencies.md for: ${missing.join(', ')}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`bom-guard: ok (${added.length} new direct dependencies)`);
  }
}
