import { test } from 'node:test';
/**
 * The extraction gate: every t() callsite is a literal the extractor can
 * see, and the es catalog covers 100% of extracted ids. A new string without
 * a translation fails HERE, not in front of a Spanish-speaking user.
 */
import { assert, assertEquals } from '@std/assert';
import { extractFromDir, extractIds, nonLiteralCallsites } from './i18n_extract.ts';
import { es } from './src/locales/es.ts';

test('extractIds sees literals, escapes, and nothing in comments', () => {
  const src = `
    // a comment mentioning t() and t(variable) never counts
    /* t('also not this') */
    const a = t('Reload gallery');
    const b = t('it\\'s escaped');
  `;
  assertEquals(extractIds(src), ['Reload gallery', "it's escaped"]);
  assertEquals(nonLiteralCallsites(src), []);
});

test('non-literal callsites are named as defects', () => {
  const bad = nonLiteralCallsites(`const x = t(label);`);
  assertEquals(bad.length, 1);
  assert(bad[0]!.startsWith('label'));
});

test('src/ has zero non-literal callsites and es covers every id', async () => {
  const { ids, bad } = await extractFromDir(new URL('./src/', import.meta.url));
  assertEquals(bad, [], 'every t() takes a literal');
  assert(ids.size >= 80, `the chrome has real string mass (${ids.size})`);
  const missing = [...ids].filter((id) => !(id in es));
  assertEquals(
    missing,
    [],
    `es is missing ${missing.length} ids - run \`npm run i18n:extract -w spritebook-studio\` for paste-ready stubs`,
  );
});

test('es translates, not parrots: most entries differ from their ids', () => {
  // loanwords (bake, rig, ok) legitimately match; the catalog as a whole must
  // not be a copy of the ids, which is what a lazy fill would produce
  const entries = Object.entries(es);
  const translated = entries.filter(([k, v]) => k !== v).length;
  assert(
    translated / entries.length > 0.7,
    `only ${translated}/${entries.length} entries differ from their ids`,
  );
});
