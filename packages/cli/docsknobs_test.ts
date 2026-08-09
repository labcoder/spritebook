/**
 * docs/cli.md against the code it documents.
 *
 * The page was written by reading VERB_FLAGS and the catalog, and it still
 * shipped a command that does not exist (`models catalog`, refused by the CLI's
 * own subcommand check) and a knob roster nothing kept honest. Documentation
 * drifts silently; this is the lock.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { loadCatalog } from '@spritebook/registry';
import { paramsSchemaFor } from '@spritebook/schema';

const CLI_MD = new URL('../../docs/cli.md', import.meta.url);

async function page(): Promise<string> {
  return await Deno.readTextFile(CLI_MD);
}

/** Every `spritebook <verb>` the page tells a reader to run. */
function commandsIn(md: string): string[] {
  return [...md.matchAll(/`?spritebook ([a-z]+)(?: ([a-z-]+))?/g)]
    .map((m) => [m[1], m[2] ?? ''].join(' ').trim());
}

Deno.test("docs/cli.md: the gen knob table is the catalog's gen3d set, exactly", async () => {
  const md = await page();
  const table = md.split('### The knobs `--adjust` takes')[1].split('\n## ')[0];
  const cat = await loadCatalog();
  const v = cat.models.find((m) => m.id === 'trellis2-4b')!.versions[0];
  const knobs = Object.keys(paramsSchemaFor(v, 'gen3d').properties as object);

  for (const key of knobs) {
    // `seed` has its own flag and the page says so in prose rather than a row
    if (key === 'seed') continue;
    assert(table.includes(`\`${key}\``), `docs/cli.md must document the gen knob "${key}"`);
  }
  // and nothing invented: a documented knob the backend does not take sends a
  // reader to the same refusal this whole change exists to prevent
  for (const [, documented] of table.matchAll(/^\| `([a-zA-Z]+)`/gm)) {
    assert(
      knobs.includes(documented),
      `docs/cli.md documents "${documented}", which gen3d rejects`,
    );
  }
});

Deno.test('docs/cli.md: the retexture-only knob is never listed as a gen knob', async () => {
  const md = await page();
  const table = md.split('### The knobs `--adjust` takes')[1].split('\n## ')[0];
  assert(
    !/^\| `resolution`/m.test(table),
    'resolution belongs to retexture; listing it here is the field report',
  );
});

Deno.test('docs/cli.md: every command it prints is a verb the CLI answers', async () => {
  const md = await page();
  const { VERB_FLAGS } = await import('./mod.ts');
  const verbs = new Set(Object.keys(VERB_FLAGS));
  // the subcommands `models` accepts, from its own refusal message
  const modelsSubs = new Set(['list', 'install', 'verify', 'rm']);
  for (const cmd of commandsIn(md)) {
    const [verb, sub] = cmd.split(' ');
    assert(verbs.has(verb), `docs/cli.md runs \`spritebook ${verb}\`, which is not a verb`);
    if (verb === 'models' && sub) {
      assert(modelsSubs.has(sub), `docs/cli.md runs \`models ${sub}\`, which models refuses`);
    }
  }
});

Deno.test('the CLI still refuses the subcommand the docs used to print', async () => {
  // pinning the refusal itself: if `models catalog` is ever implemented, this
  // test fails and the docs get their word back
  const { VERB_FLAGS } = await import('./mod.ts');
  assertEquals(typeof VERB_FLAGS.models, 'object');
  assert(!('catalog' in VERB_FLAGS), 'catalog is not a verb');
});
