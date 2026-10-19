import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decode, encode } from 'npm:fast-png@6.2.0';
import { BakeManifestSchema } from '../../packages/schema/mod.ts';

const [out, legacy] = Deno.args;
assert(out && legacy, 'usage: compare.ts <measurement-directory> <F0-control-directory>');
const measurements = JSON.parse(await readFile(`${out}/measurements.json`, 'utf8'));
const baseline = JSON.parse(await readFile(`${legacy}/report.json`, 'utf8'));
await mkdir(`${out}/diffs`); // Preserve a failed comparison instead of overwriting it.
const results = [];
const reviewIds = [
  'pixel-s1-r1',
  'pixel-s2-r1',
  'pixel-s4-r1',
  'mirrored',
  'asymmetric-pixel',
  'asymmetric-cel-2',
  'asymmetric-painterly',
  'asymmetric-clean',
];
const review = new Uint8Array(1200 * 128 * reviewIds.length * 4);
for (let i = 0; i < review.length; i += 4) review.set([24, 24, 28, 255], i);

for (const actual of measurements) {
  if (actual.engine !== 'node' || actual.temperature !== 'cold' || /-r[23]$/.test(actual.id)) {
    continue;
  }
  const expected = measurements.find((m: typeof actual) =>
    m.engine === 'deno' && m.id === actual.id && m.temperature === 'cold'
  );
  assert(expected, `missing Deno control for ${actual.id}`);
  const manifest = BakeManifestSchema.parse(
    JSON.parse(await readFile(actual.manifestPath, 'utf8')),
  );
  const control = BakeManifestSchema.parse(
    JSON.parse(await readFile(expected.manifestPath, 'utf8')),
  );
  assert.deepEqual(manifest.frames, control.frames, 'layout/pivot/mirroring must match exactly');
  assert.deepEqual(manifest.atlases, control.atlases, 'all AOV page declarations must match');
  for (const page of manifest.atlases) {
    const aBytes = await readFile(resolve(actual.manifestPath, `../${page.png}`));
    const eBytes = await readFile(resolve(expected.manifestPath, `../${page.png}`));
    const a = decode(aBytes, { checkCrc: true }), e = decode(eBytes, { checkCrc: true });
    assert.deepEqual([a.width, a.height, a.channels, a.depth], [
      e.width,
      e.height,
      e.channels,
      e.depth,
    ]);
    const exact = aBytes.equals(eBytes);
    const pixelsExact = a.data.every((value, i) => value === e.data[i]);
    const diff = new Uint8Array(a.width * a.height * 4);
    let worstFraction = 0;
    const tolerance = a.depth === 16 ? 514 : 2; // 2/255 in either channel depth.
    for (const frame of manifest.frames.filter((f) => f.atlas.pageIndex === page.pageIndex)) {
      const { x, y, w, h } = frame.atlas;
      let differing = 0;
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const pixel = (y + dy) * a.width + x + dx;
          let over = false;
          for (let c = 0; c < a.channels; c++) {
            over ||=
              Math.abs(a.data[pixel * a.channels + c] - e.data[pixel * e.channels + c]) > tolerance;
          }
          if (over) {
            differing++;
            diff.set([255, 32, 32, 255], pixel * 4);
          }
        }
      }
      worstFraction = Math.max(worstFraction, differing / (w * h));
    }
    const ok = worstFraction <= 0.005;
    if (!ok) {
      const base = `${out}/diffs/${actual.id}-${page.pass}`;
      await writeFile(`${base}-actual.png`, aBytes);
      await writeFile(`${base}-expected.png`, eBytes);
      await writeFile(`${base}-diff.png`, encode({ width: a.width, height: a.height, data: diff }));
    }
    let legacyExact: boolean | undefined;
    let legacyPixelsExact: boolean | undefined;
    if (actual.fixture === 'rigged' && !actual.mirror) {
      const f0 = baseline.measurements.find((m: { superSample: number; temperature: string }) =>
        m.superSample === actual.sample && m.temperature === 'cold'
      );
      const path = `${legacy}/workspace/bakes/bake-${f0.bakeId}/${page.png}`;
      const bytes = await readFile(path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), f0.pages[page.png], 'F0 seal');
      legacyExact = aBytes.equals(bytes);
      const f0Image = decode(bytes);
      assert.deepEqual([a.width, a.height, a.depth, a.channels], [
        f0Image.width,
        f0Image.height,
        f0Image.depth,
        f0Image.channels,
      ]);
      legacyPixelsExact = a.data.every((value, i) => value === f0Image.data[i]);
    }
    results.push({
      id: actual.id,
      pass: page.pass,
      exact,
      pixelsExact,
      worstFraction,
      ok,
      legacyExact,
      legacyPixelsExact,
    });
    if (page.pass !== 'lit') continue;
    const row = reviewIds.indexOf(actual.id);
    assert(row >= 0);
    for (
      const frame of manifest.frames.filter((f) =>
        f.clipId === manifest.frames[0].clipId && f.frame === 0 && f.direction < 4
      )
    ) {
      const r = frame.atlas;
      for (const [column, image] of [e, a, { ...a, data: diff }].entries()) {
        for (let y = 0; y < r.h; y++) {
          for (let x = 0; x < r.w; x++) {
            const from = ((r.y + y) * image.width + r.x + x) * 4;
            const to = ((row * 128 + y) * 1200 + column * 400 + frame.direction * 100 + x) * 4;
            const alpha = image.data[from + 3] / 255;
            for (let c = 0; c < 3; c++) {
              review[to + c] = Math.round(
                image.data[from + c] * alpha + review[to + c] * (1 - alpha),
              );
            }
          }
        }
      }
    }
  }
}
await writeFile(`${out}/comparison.json`, JSON.stringify(results, null, 2) + '\n');
await writeFile(
  `${out}/review.png`,
  encode({ width: 1200, height: 128 * reviewIds.length, data: review }),
);
assert(
  results.every((result) => result.ok),
  'old/new image gate failed; inspect expected/actual/diff PNGs',
);
console.log(
  JSON.stringify({
    comparedPages: results.length,
    exactPages: results.filter((r) => r.exact).length,
  }),
);
