/**
 * Pins IO: byte-deterministic on disk (canonicalJson), schema-validated in
 * BOTH directions — an invalid document neither reads nor writes.
 */
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { canonicalJson, type ProjectPins, SchemaError } from '@spritebook/schema';
import { readPins, writePins } from './pins.ts';

const PINS: ProjectPins = {
  models: { 'toy-rig': '1.0' },
  packs: { ual: '0.1.0' },
  rendererVersion: 'spritebook-render@0.1.0',
};

Deno.test('pins: write -> canonical bytes -> identical read-back', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/pins.json`;
    await writePins(path, PINS);
    assertEquals(await Deno.readTextFile(path), canonicalJson(PINS));
    assertEquals(await readPins(path), PINS);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('pins: missing, broken, and invalid documents throw actionably', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(() => readPins(`${dir}/none.json`), Error, 'cannot read pins file');
    await Deno.writeTextFile(`${dir}/broken.json`, '{');
    await assertRejects(() => readPins(`${dir}/broken.json`), Error, 'invalid JSON');
    await Deno.writeTextFile(`${dir}/wrong.json`, canonicalJson({ models: {} }));
    await assertRejects(() => readPins(`${dir}/wrong.json`), SchemaError, 'ProjectPins');
    // validation precedes the write: nothing lands for an invalid document
    const out = `${dir}/out.json`;
    await assertRejects(
      () => writePins(out, { models: {} } as unknown as ProjectPins),
      SchemaError,
    );
    assertEquals(await Deno.stat(out).catch(() => null), null, 'invalid pins never write');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
