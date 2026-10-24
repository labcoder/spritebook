/** Real reference delivery: cache replay, pixel parity, alpha/timing/pivots and 4K export. */
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runCli } from '@spritebook/cli';
import { readCurrentBake, sha256Bytes } from '@spritebook/core';
import { decode } from '@spritebook/image';
import type { ClipTiming, FrameRecord } from '@spritebook/schema';

const workspace = resolve(process.argv[2]);
const root = resolve(process.argv[3]);
await fs.mkdir(root);
const transcript: unknown[] = [];
async function cli(args: string[]) {
  const lines: string[] = [], start = performance.now();
  const exitCode = await runCli([...args, '--json'], {
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  });
  transcript.push({ args, exitCode, seconds: (performance.now() - start) / 1000, lines });
  await fs.writeFile(join(root, 'transcript.json'), JSON.stringify(transcript, null, 2));
  assert.equal(exitCode, 0, lines.join('\n'));
  return lines.map((line) => JSON.parse(line));
}
const paths = ['character.json', 'character.json.journal.ndjson', 'canonical/model.glb'];
const before = await Promise.all(paths.map((path) => fs.readFile(join(workspace, path))));
const bake = await readCurrentBake(workspace);
assert(bake);
await cli([
  'bake',
  '--workspace',
  workspace,
  '--cache',
  join(dirname(workspace), 'cache'),
  '--only-invalidated',
]);
const replay = await readCurrentBake(workspace);
assert(replay);
assert.equal(replay.manifest.bakeId, bake.manifest.bakeId);
assert.equal(replay.manifest.metrics.cacheHitPct, 100);
const events = await cli([
  'look',
  '--preview',
  '--workspace',
  workspace,
  '--clip',
  'walk-loop',
  '--frame',
  '6',
  '--direction',
  '2',
]);
const preview = JSON.parse(
  await fs.readFile(events.findLast((e) => e.kind === 'look-preview').path, 'utf8'),
);
const image = decode(await fs.readFile(preview.imagePath));
const frame = replay.manifest.frames.find((f) =>
  f.clipId === 'walk-loop' && f.direction === 2 && f.frame === 6
)!;
const page = replay.manifest.atlases.find((page) =>
  page.pass === 'lit' && page.pageIndex === frame.atlas.pageIndex
)!;
const atlas = decode(await fs.readFile(join(replay.dir, page.png)));
const pixels = new Uint8Array(image.width * image.height * 4);
for (let y = 0; y < image.height; y++) {
  pixels.set(
    atlas.data.subarray(
      ((frame.atlas.y + y) * atlas.width + frame.atlas.x) * 4,
      ((frame.atlas.y + y) * atlas.width + frame.atlas.x + image.width) * 4,
    ),
    y * image.width * 4,
  );
}
assert.deepEqual(image.data, pixels);
assert(image.data.some((value, index) => index % 4 === 3 && value === 0));
assert(image.data.some((value, index) => index % 4 === 3 && value > 0));
await cli([
  'export',
  '--workspace',
  workspace,
  '--out',
  join(root, 'iso'),
  '--targets',
  'godot,texturepacker,strips',
]);
const strips = JSON.parse(
  await fs.readFile(join(root, 'iso/strips/reference-strips.json'), 'utf8'),
) as {
  strips: { clipId: string; direction: number; fps: number; loop: boolean }[];
  pivotPx: Record<string, { x: number; y: number }>;
};
assert.equal(strips.strips.length, 32);
for (const strip of strips.strips) {
  const timing: ClipTiming = replay.manifest.clips!.find((clip) => clip.clipId === strip.clipId)!;
  assert.equal(strip.fps, timing.fps);
  assert.equal(strip.loop, timing.loop);
  const source: FrameRecord = replay.manifest.frames.find((f) =>
    f.clipId === strip.clipId && f.direction === strip.direction
  )!;
  assert.deepEqual(strips.pivotPx[`d${String(strip.direction).padStart(2, '0')}`], source.pivotPx);
}
const high = await cli([
  'bake',
  '--model',
  join(workspace, 'canonical/model.glb'),
  '--character',
  'reference-4k',
  '--out',
  join(root, '4k-bakes'),
  '--clips',
  'walk-loop:1',
  '--style',
  'clean',
  '--cell',
  '4096x4096',
  '--directions',
  '2',
  '--elevation',
  '0',
  '--yaw',
  '90',
  '--ppm',
  '1400',
  '--padding',
  '768',
  '--supersample',
  '1',
]);
const highDir = high.findLast((e) => e.kind === 'bake-dir').path;
const highManifest = JSON.parse(await fs.readFile(join(highDir, 'manifest.json'), 'utf8'));
assert.equal(highManifest.frames.length, 2);
assert(!highManifest.flags.some((flag: { code: string }) => flag.code === 'silhouette-clipped'));
await cli([
  'export',
  '--bake',
  highDir,
  '--out',
  join(root, '4k'),
  '--targets',
  'godot,texturepacker,strips',
]);
const highImage = decode(
  await fs.readFile(join(root, '4k/strips/reference-4k-walk-loop-d00-strip.png')),
);
assert.deepEqual([highImage.width, highImage.height], [4096, 4096]);
for (const [i, path] of paths.entries()) {
  assert.deepEqual(await fs.readFile(join(workspace, path)), before[i]);
}
await fs.writeFile(
  join(root, 'report.json'),
  JSON.stringify(
    {
      cacheHitPct: 100,
      exactPreviewPixels: true,
      alpha: true,
      timingAndPivots: true,
      sprite4k: true,
      modelSha256: await sha256Bytes(before[2]),
      preservedManifestAndRig: true,
      engineIntegration: false,
    },
    null,
    2,
  ),
);
console.log('DELIVERY PASS', root);
