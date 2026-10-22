import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertEquals } from '@std/assert';
import { runCli } from './dist/mod.js';
import { rigRunArgs } from '../../apps/studio/src/rig.ts';

test('template fitting refuses orientation and repair options instead of silently ignoring them', async () => {
  for (const flag of ['--face-front', '--auto-hints']) {
    const lines: string[] = [];
    assertEquals(
      await runCli(
        ['rig', '--track-a', '--model', 'unused.glb', '--out', 'unused', flag, '--json'],
        {
          stdout: (line) => lines.push(line),
          stderr: (line) => lines.push(line),
        },
      ),
      1,
    );
    assert(lines.some((line) => line.includes('require UniRig (Track B)')), lines.join('\n'));
  }
});

test('Studio orientation switches reach catalog validation without requiring values', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-rig-flags-'));
  try {
    for (const fix of ['face-front', 'feet-ground', 'center']) {
      const lines: string[] = [];
      const code = await runCli([
        ...rigRunArgs(join(root, 'hero'), { fixes: [fix] }),
        '--catalog',
        join(root, 'missing-catalog.json'),
        '--json',
      ], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });
      assertEquals(code, 1);
      const error = lines.map((line) => JSON.parse(line)).find((event) => event.t === 'error');
      assert(error, 'the missing catalog must stop the run before any inference');
      assert(error.message.includes('missing-catalog.json'), `${fix}: ${error.message}`);
    }
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

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
