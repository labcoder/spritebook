/**
 * The extraction gate: every t() callsite is a literal the extractor can
 * see, and the es catalog covers 100% of extracted ids. A new string without
 * a translation fails HERE, not in front of a Spanish-speaking user.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { extractFromDir, extractIds, nonLiteralCallsites } from './i18n_extract.ts';
import { es } from './src/locales/es.ts';

Deno.test('extractIds sees literals, escapes, and nothing in comments', () => {
  const src = `
    // a comment mentioning t() and t(variable) never counts
    /* t('also not this') */
    const a = t('Reload gallery');
    const b = t('it\\'s escaped');
  `;
  assertEquals(extractIds(src), ['Reload gallery', "it's escaped"]);
  assertEquals(nonLiteralCallsites(src), []);
});

Deno.test('non-literal callsites are named as defects', () => {
  const bad = nonLiteralCallsites(`const x = t(label);`);
  assertEquals(bad.length, 1);
  assert(bad[0]!.startsWith('label'));
});

Deno.test('src/ has zero non-literal callsites and es covers every id', async () => {
  const { ids, bad } = await extractFromDir(new URL('./src/', import.meta.url));
  assertEquals(bad, [], 'every t() takes a literal');
  assert(ids.size >= 80, `the chrome has real string mass (${ids.size})`);
  const missing = [...ids].filter((id) => !(id in es));
  assertEquals(
    missing,
    [],
    `es is missing ${missing.length} ids - run \`deno task i18n:extract\` for paste-ready stubs`,
  );
});

Deno.test('es translates, not parrots: most entries differ from their ids', () => {
  // loanwords (bake, rig, ok) legitimately match; the catalog as a whole must
  // not be a copy of the ids, which is what a lazy fill would produce
  const entries = Object.entries(es);
  const translated = entries.filter(([k, v]) => k !== v).length;
  assert(
    translated / entries.length > 0.7,
    `only ${translated}/${entries.length} entries differ from their ids`,
  );
});
