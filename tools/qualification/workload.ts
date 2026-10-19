import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { memoryUsage } from 'node:process';
import { decode } from 'npm:fast-png@6.2.0';
import { BakeManifestSchema, RENDER_PASSES } from '../../packages/schema/mod.ts';
import { runBakeJob } from '../../packages/pack/bake.ts';
import { PRESETS } from '../../packages/style/presets.ts';
import { getGpu } from '../../packages/render/gpu.ts';
import { resolveCamera } from '../../packages/core/presets.ts';

const [outArg, sampleArg = '1', styleId = 'pixel', temperature = 'cold', mirror = 'false'] =
  Deno.args;
assert(outArg, 'usage: <output> <1|2|4> <style> <cold|warm> <false|true>');
assert(['1', '2', '4'].includes(sampleArg) && styleId in PRESETS);
assert(['cold', 'warm'].includes(temperature) && ['false', 'true'].includes(mirror));
const out = resolve(outArg);
const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const packDir = fileURLToPath(new URL('../anim/packs/ual/', import.meta.url));
const asymmetric = Deno.args[5] === 'asymmetric';
const modelPath = asymmetric
  ? fileURLToPath(new URL('./fixtures/asymmetric.glb', import.meta.url))
  : `${assets}/model.glb`;
const style = structuredClone(PRESETS[styleId]);
style.temporal.superSample = Number(sampleArg) as 1 | 2 | 4;
const look = JSON.parse(await readFile(`${assets}/look.json`, 'utf8'));
const camera = resolveCamera(look.cameraPresetId, look.cameraOverrides);
await mkdir(out, { recursive: true });
const events = [];
const throughput: unknown[] = [];
const writeTextFile = Deno.writeTextFile;
Object.defineProperty(Deno, 'writeTextFile', {
  value: async (path: string | URL, text: string, options?: Deno.WriteFileOptions) => {
    if (String(path).endsWith('/throughput.json')) throughput.push(JSON.parse(text));
    await writeTextFile(path, text, options);
  },
});
const started = performance.now();
let peakRss = memoryUsage().rss;
const meter = setInterval(() => peakRss = Math.max(peakRss, memoryUsage().rss), 20);
let manifestPath: string | undefined;
try {
  for await (
    const event of runBakeJob({
      jobId: 'f2-renderer',
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
    if (event.t === 'artifact' && event.kind === 'bake-manifest') manifestPath = event.path;
  }
  const bakeWallS = (performance.now() - started) / 1000;
  assert(manifestPath && events.at(-1)?.t === 'done', 'no completed bake');
  const manifest = BakeManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  assert.equal(manifest.frames.length, asymmetric ? 32 : 96);
  assert.equal(manifest.metrics.cacheHitPct, temperature === 'warm' ? 100 : 0);
  const palette = new Set<string>(
    JSON.parse(await readFile(resolve(manifestPath, '../style-result.json'), 'utf8')).paletteHex,
  );
  const pages: Record<string, string> = {};
  let opaque = 0;
  for (const page of manifest.atlases) {
    const bytes = await readFile(resolve(manifestPath, `../${page.png}`));
    pages[page.png] = createHash('sha256').update(bytes).digest('hex');
    const image = decode(bytes);
    assert.deepEqual([image.width, image.height], [page.sizePx, page.sizePx]);
    for (const frame of manifest.frames.filter((f) => f.atlas.pageIndex === page.pageIndex)) {
      assert.equal(frame.atlas.w, 100);
      assert.equal(frame.atlas.h, 128);
      assert.deepEqual(frame.pivotPx, { x: 50, y: 112 });
      assert.equal(frame.mirroredFrom !== undefined, mirror === 'true' && frame.direction > 4);
    }
    if (page.pass !== 'lit') continue;
    for (let i = 0; i < image.data.length; i += 4) {
      if (!image.data[i + 3]) continue;
      opaque++;
      if (palette.size) {
        const hex = '#' +
          Array.from(image.data.subarray(i, i + 3), (n) => n.toString(16).padStart(2, '0')).join(
            '',
          );
        assert(palette.has(hex), `opaque color ${hex} outside recorded palette`);
      }
    }
  }
  assert(opaque > 0, 'blank atlases cannot qualify');
  assert.deepEqual(manifest.atlases.map((p) => p.pass).sort(), [...RENDER_PASSES].sort());
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
  (await getGpu()).device.destroy();
}
