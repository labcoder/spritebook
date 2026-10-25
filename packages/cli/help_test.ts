import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertEquals } from '@std/assert';
import { runCli } from './dist/mod.js';

function output() {
  const out: string[] = [], err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) },
  };
}

test('help succeeds before required values, workspace ownership and job logging', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-help-'));
  try {
    const c = output();
    assertEquals(
      await runCli([
        'gen',
        '--help',
        '--workspace',
        join(dir, 'new'),
        '--log-append',
        join(dir, 'job.ndjson'),
        '--image',
      ], c.io),
      0,
    );
    assert(c.out[0].includes('Usage: spritebook gen'));
    assertEquals(c.err, []);
    assertEquals(await fs.readdir(dir), [], 'help must not create a workspace, lock or log');
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('root help and command help are available as text and one JSON query document', async () => {
  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    const c = output();
    assertEquals(await runCli(args, c.io), 0);
    assert(c.out[0].includes('spritebook <command>'));
    assert(c.out[0].includes('import'), 'mesh import must be discoverable');
    assert(c.out[0].includes('models'));
  }
  const c = output();
  assertEquals(await runCli(['rig', '--help', '--json'], c.io), 0);
  assertEquals(c.out.length, 1);
  const doc = JSON.parse(c.out[0]);
  const options = doc.options.map((option: { flag: string }) => option.flag);
  assert(options.includes('--face-front'), 'orientation switch does not take a value');
  assert(options.includes('--model <value>'), 'input mesh option needs a value');
  assertEquals(c.err, []);
});

test('model subcommand help explains repair; invalid help commands refuse safely', async () => {
  for (const args of [['models', 'setup', '--help'], ['help', 'models', 'setup']]) {
    const c = output();
    assertEquals(await runCli(args, c.io), 0);
    assert(c.out[0].includes('spritebook models setup <id[@version]>'));
    assert(c.out[0].includes('keeping verified weights'));
  }
  for (
    const args of [['constructor', '--help'], ['help', 'models', '__proto__'], [
      'help',
      'models',
      'use',
    ]]
  ) {
    const c = output();
    assertEquals(await runCli([...args, '--json'], c.io), 1);
    assertEquals(c.out.length, 1);
    assertEquals(JSON.parse(c.out[0]).code, 'bad-args');
    assertEquals(c.err, []);
  }
});
