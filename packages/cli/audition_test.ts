import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryGetGpu } from '@spritebook/render';
import { BUNDLED_PACK } from '@spritebook/pack';
import { runCli } from './dist/mod.js';
import { canonicalJson } from '@spritebook/schema';
import { readWorkspace, sha256Bytes } from '@spritebook/core';

function runner() {
  const lines: string[] = [];
  return {
    lines,
    run: (args: string[]) =>
      runCli([...args, '--json'], {
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(line),
      }),
  };
}

test('motion audition preserves the authored rig and binds evidence to its exact source', async (context) => {
  if (!await tryGetGpu()) {
    context.skip('GPU unavailable');
    return;
  }
  const root = await fs.mkdtemp(join(tmpdir(), 'sb-audition-'));
  const workspace = join(root, 'reference');
  const { run, lines } = runner();
  try {
    assert.equal(await run(['import', '--workspace', workspace, '--example']), 0, lines.join('\n'));
    const files = ['character.json', 'character.json.journal.ndjson', 'canonical/model.glb'];
    const before = await Promise.all(files.map((path) => fs.readFile(join(workspace, path))));
    assert.equal(await run(['anim', '--audition', '--workspace', workspace]), 0, lines.join('\n'));
    for (const [i, path] of files.entries()) {
      assert.deepEqual(await fs.readFile(join(workspace, path)), before[i]);
    }
    assert.equal(await run(['anim', '--review', '--workspace', workspace]), 0);
    const report = JSON.parse(lines.at(-1)!);
    assert.equal(report.clips.length, 4);
    assert(
      report.clips.every((clip: { stats: { frames: number; measuredEdges: number } }) =>
        clip.stats.frames === 17 && clip.stats.measuredEdges > 1000
      ),
    );
    for (const clip of report.clips) {
      assert((await fs.stat(clip.contact)).size > 100);
      assert((await fs.stat(clip.preview)).size > 100);
    }
    await fs.rm(report.clips[0].contact);
    assert.equal(await run(['anim', '--review', '--workspace', workspace]), 0);
    assert.equal(
      lines.at(-1)!.trim(),
      'null',
      'Missing review images must invalidate derived evidence',
    );
    assert.equal(await run(['anim', '--audition', '--workspace', workspace]), 0, lines.join('\n'));
    assert((await fs.stat(report.clips[0].contact)).size > 100);
    const candidateDir = join(workspace, 'results/r1');
    await fs.mkdir(candidateDir, { recursive: true });
    await fs.writeFile(join(candidateDir, 'model.glb'), before[2]);
    const parent = await readWorkspace(workspace);
    parent.generation.results.push({
      id: 'r1',
      backend: { modelId: 'fixture-gen', version: '1.0.0' },
      params: {},
      seed: 0,
      discarded: false,
      startedAt: parent.createdAt,
      wallTimeS: 0,
      output: {
        kind: 'mesh',
        gltfSha256: report.sourceSha256,
        bodies: 1,
        tris: 15060,
        textureRes: 512,
      },
    });
    await fs.writeFile(join(workspace, 'character.json'), canonicalJson(parent));
    const recipe = {
      method: 'candidate-motion@1',
      sourceSha256: report.sourceSha256,
      pins: null,
      backendVersion: 'fixture-receipt',
      upright: false,
    };
    const draftRoot = join(
      workspace,
      'anim/candidates/r1',
      await sha256Bytes(new TextEncoder().encode(canonicalJson(recipe))),
    );
    const draft = join(draftRoot, 'character');
    assert.equal(await run(['import', '--workspace', draft, '--example']), 0, lines.join('\n'));
    assert.equal(await run(['anim', '--audition', '--workspace', draft]), 0, lines.join('\n'));
    await fs.writeFile(
      join(workspace, 'anim/candidates/r1/review-no-upright.json'),
      canonicalJson(recipe),
    );
    assert.equal(
      await run(['anim', '--review', '--result', 'r1', '--no-upright', '--workspace', workspace]),
      0,
      lines.join('\n'),
    );
    assert.equal(JSON.parse(lines.at(-1)!).sourceSha256, report.sourceSha256);
    assert.equal(await run(['anim', '--review', '--result', 'r1', '--workspace', workspace]), 0);
    assert.equal(
      lines.at(-1)!.trim(),
      'null',
      'A no-upright draft cannot stand in for auto alignment',
    );
    const saved = await fs.readFile(join(workspace, 'anim/motion-review.json'));
    await fs.appendFile(join(workspace, 'canonical/model.glb'), 'corruption');
    assert.equal(await run(['anim', '--review', '--workspace', workspace]), 0);
    assert.equal(lines.at(-1)!.trim(), 'null');
    assert.equal(await run(['anim', '--audition', '--workspace', workspace]), 1);
    assert.deepEqual(await fs.readFile(join(workspace, 'anim/motion-review.json')), saved);
    await fs.writeFile(join(workspace, 'canonical/model.glb'), before[2]);
    await fs.writeFile(
      join(root, 'pins.json'),
      JSON.stringify({ rendererVersion: 'test', models: {}, packs: {} }),
    );
    assert.equal(await run(['anim', '--audition', '--workspace', workspace]), 1);
    assert(lines.some((line) => line.includes('no packs version')));
    assert.deepEqual(await fs.readFile(join(workspace, 'anim/motion-review.json')), saved);
    const pack = JSON.parse(await fs.readFile(join(BUNDLED_PACK, 'pack.json'), 'utf8'));
    const explicit = join(root, 'allowed-pins.json');
    await fs.writeFile(
      explicit,
      JSON.stringify({
        models: {},
        packs: { [pack.id]: pack.version },
        rendererVersion: 'reserved',
      }),
    );
    assert.equal(await run(['anim', '--review', '--workspace', workspace, '--pins', explicit]), 0);
    assert.equal(JSON.parse(lines.at(-1)!).sourceSha256, report.sourceSha256);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('motion actions refuse ambiguous flags and missing rigs without creating a report', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'sb-audition-refuse-'));
  const { run, lines } = runner();
  try {
    for (
      const extra of [['--preview', 'walk-loop'], ['--packs', 'elsewhere'], ['--no-upright'], [
        '--result',
        '../escape',
      ]]
    ) {
      assert.equal(await run(['anim', '--audition', '--workspace', root, ...extra]), 1);
    }
    assert.equal(await run(['anim', '--audition', '--workspace', root]), 1);
    assert.equal(await run(['anim', '--list', '--result', 'r1']), 1);
    assert.equal(await run(['anim', '--list', '--no-upright']), 1);
    assert(lines.some((line) => line.includes('bad-args')));
    await assert.rejects(fs.stat(join(root, 'anim/motion-review.json')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
