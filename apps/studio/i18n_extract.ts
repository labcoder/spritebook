/**
 * The extraction pass (hard commitment 3). Callsites are `t('literal')` —
 * this walks src/, collects every id, and holds the es catalog to 100%
 * coverage. Run it as a command (`deno task i18n:extract`) for a report, or
 * let the test import the same functions so CI refuses a missing string.
 *
 * It also REFUSES non-literal callsites (t(`…`), t(variable)): an id the
 * extractor cannot see is a string no catalog can translate.
 */

/** Comments carry prose like "t() re-renders" — never callsites. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

export function extractIds(source: string): string[] {
  // both quote styles: a formatter config drift must never blind extraction
  const ids: string[] = [];
  const src = stripComments(source);
  for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'\s*,?\s*\)/g)) {
    ids.push(m[1]!.replace(/\\'/g, "'"));
  }
  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"\s*,?\s*\)/g)) {
    ids.push(m[1]!.replace(/\\"/g, '"'));
  }
  return ids;
}

/** t( callsites the literal extractor CANNOT see — these are defects. */
export function nonLiteralCallsites(source: string): string[] {
  const bad: string[] = [];
  // `function t(` is the definition, not a callsite
  for (
    const m of stripComments(source).matchAll(/(?<!function )\bt\((?!\s*['"])(.{0,40})/g)
  ) {
    bad.push(m[1]!.trimEnd());
  }
  return bad;
}

export async function extractFromDir(dir: URL): Promise<{ ids: Set<string>; bad: string[] }> {
  const ids = new Set<string>();
  const bad: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const child = new URL(`${entry.name}${entry.isDirectory ? '/' : ''}`, dir);
    if (entry.isDirectory) {
      const sub = await extractFromDir(child);
      sub.ids.forEach((id) => ids.add(id));
      bad.push(...sub.bad);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      const text = await Deno.readTextFile(child);
      extractIds(text).forEach((id) => ids.add(id));
      nonLiteralCallsites(text).forEach((b) => bad.push(`${entry.name}: t(${b}`));
    }
  }
  return { ids, bad };
}

if (import.meta.main) {
  const { ids, bad } = await extractFromDir(new URL('./src/', import.meta.url));
  const { es } = await import('./src/locales/es.ts');
  const missing = [...ids].filter((id) => !(id in es)).sort();
  const unused = Object.keys(es).filter((k) => !ids.has(k)).sort();
  console.log(`${ids.size} ids extracted from src/`);
  if (bad.length > 0) {
    console.log(`NON-LITERAL callsites (defects):`);
    for (const b of bad) console.log(`  ${b}`);
  }
  if (missing.length > 0) {
    console.log(`es MISSING ${missing.length}:`);
    for (const id of missing) console.log(`  '${id.replace(/'/g, "\\'")}': '',`);
  }
  if (unused.length > 0) {
    console.log(`es unused ${unused.length}: ${unused.join(' | ')}`);
  }
  Deno.exit(bad.length > 0 || missing.length > 0 ? 1 : 0);
}
