import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { memoryUsage } from 'node:process';
import { decode } from 'fast-png';
const [runtimeArg, controlArg] = process.argv.slice(2);
assert(
  runtimeArg && controlArg,
  'usage: runtime-workload.ts <Node-runtime> <F2-control-runtime> <output> [sample/style/temperature/mirror/fixture]',
);
const runtime = resolve(runtimeArg), control = resolve(controlArg);
process.env.SPRITEBOOK_RESOURCES = resolve(runtime, 'assets');
const load = (name: string) =>
  import(pathToFileURL(resolve(runtime, 'node_modules/@spritebook', name, 'dist/mod.js')).href);
const { BakeManifestSchema, RENDER_PASSES } = await load(
  'schema',
) as typeof import('@spritebook/schema');
const { runBakeJob } = await load('pack') as typeof import('@spritebook/pack');
const { PRESETS } = await load('style') as typeof import('@spritebook/style');
const { disposeGpu } = await load('render') as typeof import('@spritebook/render');
const { getGpu } = await import(
  pathToFileURL(resolve(runtime, 'node_modules/@spritebook/render/dist/gpu.js')).href
) as typeof import('../../packages/render/dist/gpu.js');
const { resolveCamera } = await load('core') as typeof import('@spritebook/core');

const [
  outArg,
  sampleArg = '1',
  styleId = 'pixel',
  temperature = 'cold',
  mirror = 'false',
] = process.argv.slice(4);
assert(outArg, 'usage: <output> <1|2|4> <style> <cold|warm> <false|true>');
assert(['1', '2', '4'].includes(sampleArg) && styleId in PRESETS);
assert(
  ['cold', 'warm'].includes(temperature) && ['false', 'true'].includes(mirror),
);
const out = resolve(outArg);
const assets = resolve(control, 'assets');
const packDir = resolve(runtime, 'assets/anim/packs/ual');
const asymmetric = process.argv[9] === 'asymmetric';
const modelPath = asymmetric ? resolve(runtime, 'sample/asymmetric.glb') : `${assets}/model.glb`;
const style = structuredClone(PRESETS[styleId]);
style.temporal.superSample = Number(sampleArg) as 1 | 2 | 4;
const look = JSON.parse(await readFile(`${assets}/look.json`, 'utf8'));
const camera = resolveCamera(look.cameraPresetId, look.cameraOverrides);
await mkdir(out, { recursive: true });
const events = [];
const throughput: unknown[] = [];
const started = performance.now();
let peakRss = memoryUsage().rss;
const meter = setInterval(
  () => peakRss = Math.max(peakRss, memoryUsage().rss),
  20,
);
let manifestPath: string | undefined;
try {
  for await (
    const event of runBakeJob({
      jobId: 'f4-renderer',
      characterId: 'migration-control',
      modelPath,
      packDir,
      camera,
      style,
      frames: 4,
      clips: asymmetric ? undefined : ['idle-loop', 'walk-loop', 'punch-jab'].map((clipId) => ({
        clipId,
        frames: 4,
        speed: 1,
        holdLast: false,
      })),
      outRoot: `${out}/bakes`,
      cacheDir: `${out}/cache`,
      onlyInvalidated: temperature === 'warm',
      mirroring: mirror === 'true',
    })
  ) {
    console.log(JSON.stringify(event));
    events.push(event);
    assert(event.t !== 'error', JSON.stringify(event));
    if (event.t === 'artifact' && event.kind === 'bake-manifest') {
      manifestPath = event.path;
    }
  }
  const bakeWallS = (performance.now() - started) / 1000;
  assert(manifestPath && events.at(-1)?.t === 'done', 'no completed bake');
  const manifest = BakeManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );
  assert.equal(manifest.frames.length, asymmetric ? 32 : 96);
  assert.equal(manifest.metrics.cacheHitPct, temperature === 'warm' ? 100 : 0);
  const palette = new Set<string>(
    JSON.parse(
      await readFile(resolve(manifestPath, '../style-result.json'), 'utf8'),
    ).paletteHex,
  );
  const pages: Record<string, string> = {};
  let opaque = 0;
  for (const page of manifest.atlases) {
    const bytes = await readFile(resolve(manifestPath, `../${page.png}`));
    pages[page.png] = createHash('sha256').update(bytes).digest('hex');
    const image = decode(bytes, { checkCrc: true });
    assert.deepEqual([image.width, image.height], [page.sizePx, page.sizePx]);
    for (
      const frame of manifest.frames.filter((f) => f.atlas.pageIndex === page.pageIndex)
    ) {
      assert.equal(frame.atlas.w, 100);
      assert.equal(frame.atlas.h, 128);
      assert.deepEqual(frame.pivotPx, { x: 50, y: 112 });
      assert.equal(
        frame.mirroredFrom !== undefined,
        mirror === 'true' && frame.direction > 4,
      );
    }
    if (page.pass !== 'lit') continue;
    for (let i = 0; i < image.data.length; i += 4) {
      if (!image.data[i + 3]) continue;
      opaque++;
      if (palette.size) {
        const hex = '#' +
          Array.from(
            image.data.subarray(i, i + 3),
            (n) => n.toString(16).padStart(2, '0'),
          ).join(
            '',
          );
        assert(
          palette.has(hex),
          `opaque color ${hex} outside recorded palette`,
        );
      }
    }
  }
  assert(opaque > 0, 'blank atlases cannot qualify');
  assert.deepEqual(
    manifest.atlases.map((p) => p.pass).sort(),
    [...RENDER_PASSES].sort(),
  );
  const gpu = await getGpu();
  assert.equal(gpu.lost, null);
  await writeFile(
    `${out}/${temperature}.json`,
    JSON.stringify(
      {
        bakeWallS,
        peakRss,
        manifestPath,
        pages,
        adapter: gpu.adapterInfo,
        features: gpu.features,
        throughput,
        frames: manifest.frames.length,
        cacheHitPct: manifest.metrics.cacheHitPct,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  clearInterval(meter);
  await disposeGpu();
}
