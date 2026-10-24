import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { createWorkspace, readWorkspace, resourcePath, sha256Bytes } from '@spritebook/core';
import { runCli } from './dist/mod.js';
import { loadSkinnedAsset, posedBounds } from '../render/dist/skinning.js';

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

test('an interrupted initial import resumes without allowing an overwrite after undo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spritebook-import-retry-'));
  try {
    const modelIO = new NodeIO();
    const upload = await modelIO.read(resourcePath('rig', 'bodies/ubc-male/body.glb'));
    upload.getRoot().listScenes()[0].listChildren()[0]
      .setScale([1.2, 1.2, 1.2]).setTranslation([.2, .25, .1]);
    const model = join(root, 'uploaded.glb');
    const original = await modelIO.writeBinary(upload);
    await writeFile(model, original);
    await createWorkspace({
      workspace: root,
      characterId: 'retry',
      displayName: 'Retry',
      source: { kind: 'mesh', originalFilename: 'body.glb', sha256: await sha256Bytes(original) },
    });
    await writeFile(join(root, 'source/preflight.json'), 'interrupted');
    const lines: string[] = [];
    const io = {
      stdout: (line: string) => lines.push(line),
      stderr: (line: string) => lines.push(line),
    };
    assert.equal(
      await runCli([
        'import',
        '--workspace',
        root,
        '--character',
        'retry',
        '--model',
        model,
        '--height',
        '1.6',
        '--json',
      ], io),
      0,
      lines.join('\n'),
    );
    assert.equal((await readWorkspace(root)).canonicalMesh?.heightM, 1.6);
    const actual = posedBounds(
      await loadSkinnedAsset(join(root, 'canonical/model.glb')),
      1,
      'idle',
    );
    assert(
      Math.abs(actual.min[1]) < 1e-5,
      'The skinned feet, not just mesh bounds, reach the floor',
    );
    assert(
      Math.abs(actual.max[1] - actual.min[1] - 1.6) < 1e-5,
      'The actual skinned surface is 1.6 m',
    );
    const doc = await new NodeIO().readBinary(
      new Uint8Array(await readFile(join(root, 'canonical/model.glb'))),
    );
    const source = await new NodeIO().readBinary(original);
    for (const [index, mesh] of source.getRoot().listMeshes().entries()) {
      for (const [p, primitive] of mesh.listPrimitives().entries()) {
        const weights = (prim: typeof primitive) =>
          prim.getAttribute('WEIGHTS_0')
            ? Array.from(prim.getIndices()!.getArray()!).flatMap((vertex) =>
              prim.getAttribute('WEIGHTS_0')!.getElement(vertex, [])
            )
            : undefined;
        assert.deepEqual(
          weights(doc.getRoot().listMeshes()[index].listPrimitives()[p]),
          weights(primitive),
        );
      }
    }
    assert.equal(
      await runCli(['undo', '--manifest', join(root, 'character.json'), '--json'], io),
      0,
    );
    assert.equal(
      await runCli([
        'import',
        '--workspace',
        root,
        '--character',
        'retry',
        '--model',
        model,
        '--json',
      ], io),
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
