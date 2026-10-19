import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Pins IO: byte-deterministic on disk (canonicalJson), schema-validated in
 * BOTH directions — an invalid document neither reads nor writes.
 */
import { assertEquals, assertRejects } from '@std/assert';
import { canonicalJson, type ProjectPins, SchemaError } from '@spritebook/schema';
import { readPins, writePins } from './dist/pins.js';

const PINS: ProjectPins = {
  models: { 'toy-rig': '1.0' },
  packs: { ual: '0.1.0' },
  rendererVersion: 'spritebook-render@0.1.0',
};

test('pins: write -> canonical bytes -> identical read-back', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const path = `${dir}/pins.json`;
    await writePins(path, PINS);
    assertEquals(await fs.readFile(path, 'utf8'), canonicalJson(PINS));
    assertEquals(await readPins(path), PINS);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('pins: missing, broken, and invalid documents throw actionably', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await assertRejects(() => readPins(`${dir}/none.json`), Error, 'cannot read pins file');
    await fs.writeFile(`${dir}/broken.json`, '{');
    await assertRejects(() => readPins(`${dir}/broken.json`), Error, 'invalid JSON');
    await fs.writeFile(`${dir}/wrong.json`, canonicalJson({ models: {} }));
    await assertRejects(() => readPins(`${dir}/wrong.json`), SchemaError, 'ProjectPins');
    // validation precedes the write: nothing lands for an invalid document
    const out = `${dir}/out.json`;
    await assertRejects(
      () => writePins(out, { models: {} } as unknown as ProjectPins),
      SchemaError,
    );
    assertEquals(await fs.stat(out).catch(() => null), null, 'invalid pins never write');
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
