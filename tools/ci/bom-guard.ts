/**
 * Working-agreement check: every new dependency gets a row in
 * docs/dependencies.md in the same change (AGENTS.md; BOM rule).
 * Compares deno.lock package names against the base ref and requires each
 * newly appearing npm/jsr package to be mentioned in docs/dependencies.md.
 *
 *   deno run --allow-run --allow-read tools/ci/bom-guard.ts --base origin/main
 */
const baseIdx = Deno.args.indexOf('--base');
const base = baseIdx >= 0 ? Deno.args[baseIdx + 1] : 'origin/main';

async function git(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const res = await new Deno.Command('git', { args, stdout: 'piped', stderr: 'null' }).output();
  return { ok: res.code === 0, out: new TextDecoder().decode(res.stdout) };
}

function packageNames(lock: string): Set<string> {
  const names = new Set<string>();
  // top-level specifier keys: "npm:name@version" / "jsr:@scope/name@version"
  for (const m of lock.matchAll(/"(?:npm|jsr):((?:@[\w.-]+\/)?[\w.-]+)@/g)) names.add(m[1]);
  return names;
}

const head = await Deno.readTextFile('deno.lock').catch(() => '');
const baseLock = await git('show', `${base}:deno.lock`);
const before = packageNames(baseLock.ok ? baseLock.out : '');
const after = packageNames(head);
const added = [...after].filter((n) => !before.has(n));

if (added.length === 0) {
  console.log('bom-guard: no new dependencies');
  Deno.exit(0);
}

const bom = (await Deno.readTextFile('docs/dependencies.md')).toLowerCase();
const missing = added.filter((n) => !bom.includes(n.toLowerCase().replace(/^@[\w.-]+\//, '')));

if (missing.length > 0) {
  console.error('bom-guard: new dependencies missing from docs/dependencies.md:');
  for (const n of missing) console.error(`  ${n}`);
  console.error('add a row with role + license in the same change (AGENTS.md).');
  Deno.exit(1);
}
console.log(`bom-guard: ok (${added.length} new dep(s), all in the BOM)`);
