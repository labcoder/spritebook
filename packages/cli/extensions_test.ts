import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assert, assertEquals } from '@std/assert';
import { runCli } from './dist/mod.js';

test('extension inventory includes models, optional tools and bundled content without creating installs', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-extensions-'));
  try {
    const lines: string[] = [];
    const args = [
      '--models-dir',
      join(root, 'models'),
      '--tools-dir',
      join(root, 'tools'),
      '--json',
    ];
    assertEquals(
      await runCli(['extensions', 'list', ...args], {
        stdout: (s) => lines.push(s),
        stderr: (s) => {
          throw new Error(s);
        },
      }),
      0,
    );
    assertEquals(lines.length, 1);
    const doc = JSON.parse(lines[0]);
    assert(doc.models.some((m: { id: string }) => m.id === 'unirig'));
    assertEquals(doc.tools[0].id, 'blender');
    assertEquals(doc.tools[0].selected, null);
    assert(doc.content.some((c: { kind: string }) => c.kind === 'animation-pack'));
    assertEquals(await fs.readdir(root), []);
    for (const flags of [['--path'], ['--path', '/somewhere'], ['--catalog', 'unused']]) {
      const failures: string[] = [];
      assertEquals(
        await runCli(['extensions', 'verify', 'blender', ...flags, '--json'], {
          stdout: (s) => failures.push(s),
          stderr: (s) => failures.push(s),
        }),
        1,
      );
      assertEquals(failures.length, 1);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
