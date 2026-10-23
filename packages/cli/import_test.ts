import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { readWorkspace } from '@spritebook/core';
import { runCli } from './dist/mod.js';

test('offline example preserves its authored rig and import is an asset-aware undo step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spritebook-example-'));
  const workspace = join(root, 'reference');
  const lines: string[] = [];
  const run = (args: string[]) =>
    runCli([...args, '--json'], {
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
  try {
    assert.equal(await run(['import', '--workspace', workspace, '--example']), 0, lines.join('\n'));
    const imported = await readWorkspace(workspace);
    assert.equal(imported.source.kind, 'mesh');
    assert.equal(imported.canonicalMesh?.texturedBy, 'source');
    assert.equal(imported.generation.results.length, 0);
    assert.equal(imported.rig?.accepted, false);
    const bytes = await readFile(join(workspace, 'canonical/model.glb'));
    const doc = await new NodeIO().readBinary(new Uint8Array(bytes));
    assert.equal(doc.getRoot().listSkins()[0].listJoints().length, 65);
    assert.equal(
      await run(['anim', '--preview', 'walk-loop', '--workspace', workspace]),
      0,
      lines.join('\n'),
    );
    assert.equal(
      await run(['anim', '--preview', 'jump-start', '--workspace', workspace]),
      0,
      lines.join('\n'),
    );
    assert.equal(await run(['undo', '--manifest', join(workspace, 'character.json')]), 0);
    assert.equal((await readWorkspace(workspace)).canonicalMesh, undefined);
    assert.equal(await run(['redo', '--manifest', join(workspace, 'character.json')]), 0);
    assert.deepEqual(await readFile(join(workspace, 'canonical/model.glb')), bytes);
    assert.equal(await run(['import', '--workspace', workspace, '--example']), 1);
    assert.deepEqual(await readWorkspace(workspace), imported);
    assert.deepEqual(await readFile(join(workspace, 'canonical/model.glb')), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('import requires an explicit source and refuses unknown switches', async () => {
  for (const args of [[], ['--example', '--model', 'mesh.glb'], ['--example', '--replace']]) {
    const lines: string[] = [];
    assert.equal(
      await runCli(['import', '--workspace', 'unused', ...args, '--json'], {
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(line),
      }),
      1,
    );
    assert(lines.some((line) => /bad-args|unknown-flag/.test(line)));
  }
});
