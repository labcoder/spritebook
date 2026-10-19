import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertEquals } from '@std/assert';
import { runCli } from './dist/mod.js';

test('missing and repeated flag values refuse before touching workspaces', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    for (
      const flags of [
        ['--seed'],
        ['--model', '--json'],
        ['--seed', '1', '--seed', '2'],
        ['--image', ''],
        ['--workspace', `${root}/second`],
      ]
    ) {
      const lines: string[] = [];
      const code = await runCli(['gen', '--workspace', `${root}/hero`, '--json', ...flags], {
        stdout: (line) => lines.push(line),
        stderr: (line) => {
          throw new Error(line);
        },
      });
      assertEquals(code, 1);
      assertEquals(lines.length, 1);
      assertEquals(JSON.parse(lines[0]).code, 'bad-args');
      assert(JSON.parse(lines[0]).message.includes('value'));
      assertEquals(await Array.fromAsync(await fs.readdir(root, { withFileTypes: true })), []);
    }
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
