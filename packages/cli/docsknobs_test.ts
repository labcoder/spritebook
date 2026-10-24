import { promises as fs } from 'node:fs';
import { test } from 'node:test';
/**
 * docs/cli.md against the code it documents.
 *
 * The page was written by reading VERB_FLAGS and the catalog, and it still
 * shipped a command that does not exist (`models catalog`, refused by the CLI's
 * own subcommand check) and a knob roster nothing kept honest. Documentation
 * drifts silently; this is the lock.
 */
import { assert, assertEquals } from '@std/assert';
import { loadCatalog } from '@spritebook/registry';
import { paramsSchemaFor } from '@spritebook/schema';

const CLI_MD = new URL('../../docs/user/cli.md', import.meta.url);

async function page(): Promise<string> {
  return await fs.readFile(CLI_MD, 'utf8');
}

/** Every `spritebook <verb>` the page tells a reader to run. */
function commandsIn(md: string): string[] {
  return [...md.matchAll(/`?spritebook ([a-z]+)(?: ([a-z-]+))?/g)]
    .map((m) => [m[1], m[2] ?? ''].join(' ').trim());
}

for (const id of ['trellis2-4b', 'pixal3d']) {
  test(`docs/cli.md: ${id} knobs match its gen3d schema`, async () => {
    const md = await page();
    const table = md.split(`\`${id}\`:`)[1].trimStart().split(/\r?\n\r?\n/)[0];
    const cat = await loadCatalog();
    const v = cat.models.find((m) => m.id === id)!.versions[0];
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
}

test('docs/cli.md: the retexture-only knob is never listed as a gen knob', async () => {
  const md = await page();
  const table = md.split('### The knobs `--adjust` takes')[1].split('\n## ')[0];
  assert(
    !/^\| `resolution`/m.test(table),
    'resolution belongs to retexture; listing it here is the field report',
  );
});

test('docs/cli.md: every command it prints is a verb the CLI answers', async () => {
  const md = await page();
  const { VERB_FLAGS, runCli } = await import('./dist/mod.js');
  const verbs = new Set(Object.keys(VERB_FLAGS));
  for (const cmd of commandsIn(md)) {
    const [verb, sub] = cmd.split(' ');
    assert(verbs.has(verb), `docs/cli.md runs \`spritebook ${verb}\`, which is not a verb`);
    if (verb === 'models' && sub) {
      const lines: string[] = [];
      const code = await runCli(['models', sub], {
        stdout: (s) => lines.push(s),
        stderr: (s) => lines.push(s),
      });
      assert(
        sub === 'list' ? code === 0 : lines.some((s) => s.includes(`models ${sub} <id`)),
        `docs/cli.md runs \`models ${sub}\`, which models refuses`,
      );
    }
  }
});

test('the CLI still refuses the subcommand the docs used to print', async () => {
  // pinning the refusal itself: if `models catalog` is ever implemented, this
  // test fails and the docs get their word back
  const { runCli } = await import('./dist/mod.js');
  const lines: string[] = [];
  assertEquals(
    await runCli(['models', 'catalog'], {
      stdout: (s) => lines.push(s),
      stderr: (s) => lines.push(s),
    }),
    1,
  );
  assert(lines.some((s) => s.includes('models needs a subcommand')));
});
