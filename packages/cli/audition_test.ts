import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryGetGpu } from '@spritebook/render';
import { BUNDLED_PACK } from '@spritebook/pack';
import { runCli } from './dist/mod.js';

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
      const extra of [['--preview', 'walk-loop'], ['--packs', 'elsewhere'], [
        '--result',
        '../escape',
      ]]
    ) {
      assert.equal(await run(['anim', '--audition', '--workspace', root, ...extra]), 1);
    }
    assert.equal(await run(['anim', '--audition', '--workspace', root]), 1);
    assert.equal(await run(['anim', '--list', '--result', 'r1']), 1);
    assert(lines.some((line) => line.includes('bad-args')));
    await assert.rejects(fs.stat(join(root, 'anim/motion-review.json')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
