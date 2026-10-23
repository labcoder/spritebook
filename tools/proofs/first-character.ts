/** Real, offline authored-rig → walk/jump → sprites → export proof. No AI downloads. */
import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runCli } from '@spritebook/cli';
import { readCurrentBake, readWorkspace } from '@spritebook/core';
import { decode } from '@spritebook/image';
import { disposeGpu } from '@spritebook/render';

const root = resolve(process.argv[2] ?? '.render-bench/first-character');
await mkdir(root);
const workspace = join(root, 'reference');
const transcript: { args: string[]; exitCode: number; seconds: number; lines: string[] }[] = [];
async function cli(args: string[]) {
  const lines: string[] = [];
  const start = performance.now();
  const exitCode = await runCli([...args, '--json'], {
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  });
  transcript.push({ args, exitCode, seconds: (performance.now() - start) / 1000, lines });
  await writeFile(join(root, 'transcript.json'), JSON.stringify(transcript, null, 2));
  assert.equal(exitCode, 0, `${args.join(' ')}\n${lines.join('\n')}`);
  console.log(args[0], args[1], transcript.at(-1)!.seconds.toFixed(2), 's');
}
try {
  await cli(['import', '--workspace', workspace, '--example']);
  for (const clip of ['walk-loop', 'jump-start', 'jump-loop', 'jump-land']) {
    await cli(['anim', '--preview', clip, '--workspace', workspace]);
  }
  await cli(['rig', '--accept', '--workspace', workspace]);
  const clips = 'walk-loop:16,jump-start:12!hold,jump-loop:12,jump-land:12!hold';
  const reports: unknown[] = [];
  for (
    const [name, size, directions, elevation, yaw, ppm] of [
      ['side-64', '64x80', '2', '0', '90', '23'],
      ['iso-256', '256x320', '8', '35.3', '0', '90'],
    ]
  ) {
    await cli([
      'bake',
      '--workspace',
      workspace,
      '--clips',
      clips,
      '--style',
      'clean',
      '--cell',
      size,
      '--directions',
      directions,
      '--elevation',
      elevation,
      '--yaw',
      yaw,
      '--ppm',
      ppm,
      '--cache',
      join(root, 'cache'),
    ]);
    const bake = await readCurrentBake(workspace);
    assert(bake);
    assert.equal(bake.manifest.frames.length, 52 * Number(directions));
    assert.equal(bake.manifest.frames.some((frame) => frame.mirroredFrom), false);
    assert.equal(bake.manifest.flags.some((flag) => flag.severity === 'error'), false);
    for (const page of bake.manifest.atlases) {
      const image = decode(await readFile(join(bake.dir, page.png)));
      assert.equal(image.width, page.sizePx);
      assert.equal(image.height, page.sizePx);
      assert.equal(page.layoutSharedWith, 'lit');
    }
    assert.equal(bake.manifest.clips!.find((clip) => clip.clipId === 'jump-land')!.loop, false);
    assert.equal(bake.manifest.clips!.find((clip) => clip.clipId === 'walk-loop')!.loop, true);
    await cli([
      'export',
      '--workspace',
      workspace,
      '--out',
      join(root, name),
      '--targets',
      'godot,texturepacker,strips',
      '--mesh',
    ]);
    reports.push({
      name,
      bakeId: bake.manifest.bakeId,
      frames: bake.manifest.frames.length,
      flags: bake.manifest.flags,
    });
  }
  assert.equal((await readWorkspace(workspace)).source.kind, 'mesh');
  await writeFile(
    join(root, 'report.json'),
    JSON.stringify({ reports, modelDownloads: 0, engineIntegrationTested: false }, null, 2),
  );
} finally {
  disposeGpu();
}
