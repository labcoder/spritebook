import { runProcess } from '../testing/process.ts';
import { promises as fs } from 'node:fs';
/** F0-T4: preserve a small legacy workspace, exports and cold/warm measurements.
 * Run from the repo root with Vulkan (Windows/Linux) or Metal (macOS):
 * deno run --allow-read --allow-write --allow-env --allow-ffi --allow-net=127.0.0.1 \
 *   --allow-run \
 *   tools/proofs/migration-baseline.ts .render-bench/f0/control
 * The output directory must not exist. Existing controls are never replaced.
 */
import { assert, assertEquals } from '@std/assert';
import { readWorkspace, setLook } from '../../packages/core/dist/mod.js';
import { BakeManifestSchema, canonicalJson } from '../../packages/schema/dist/mod.js';
import { PIXEL } from '../../packages/style/dist/mod.js';

const repo = decodeURIComponent(new URL('../../', import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1');
const out = process.argv.slice(2)[0] ?? '.render-bench/f4/control';
await fs.mkdir(out); // EEXIST protects the original control, including failed runs.
const workspace = `${out}/workspace`;
const models = `${out}/models`;
const transcript: {
  args: string[];
  code: number;
  stdout: string[];
  stderr: string[];
}[] = [];

async function cli(args: string[]) {
  // Match Tauri's process-per-verb execution, including runtime/adapter startup.
  const result = await runProcess(process.execPath, [
    `${repo}packages/cli/dist/entry.js`,
    ...args,
    '--json',
  ]);
  const lines = (bytes: Uint8Array) =>
    new TextDecoder().decode(bytes).split(/\r?\n/).filter(Boolean);
  const stdout = lines(result.stdout),
    stderr = lines(result.stderr),
    code = result.code;
  transcript.push({ args, code, stdout, stderr });
  await fs.writeFile(
    `${out}/commands.json`,
    JSON.stringify(transcript, null, 2) + '\n',
  );
  assertEquals(
    code,
    0,
    `${args[0]} failed:\n${[...stdout, ...stderr].join('\n')}`,
  );
  return stdout;
}

async function hash(path: string) {
  const bytes = new Uint8Array(await fs.readFile(path));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const git = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repo });
assert(git.success, 'recording the exact source commit is required');
const sourceCommit = new TextDecoder().decode(git.stdout).trim();
const startedAt = new Date().toISOString();
const inputs: Record<string, string> = {};
for (
  const path of [
    'package.json',
    'package-lock.json',
    '.node-version',
    'tools/proofs/migration-baseline.ts',
    'tests/fixtures/bulma-front.png',
    'packages/style/fixtures/asymmetric.glb',
    'packages/render/fixtures/skinned-column.glb',
    'packages/render/shaders.wgsl',
    'packages/rig/bodies/ubc-male/body.glb',
    'packages/rig/bodies/ubc-male/body.json',
    ...['idle-loop', 'walk-loop', 'punch-jab'].map((id) =>
      `packages/anim/packs/ual/clips/${id}.glb`
    ),
  ]
) inputs[path] = await hash(`${repo}${path}`);

await cli(['models', 'install', 'fixture-gen', '--models-dir', models]);
await cli([
  'gen',
  '--workspace',
  workspace,
  '--character',
  'migration-control',
  '--image',
  `${repo}tests/fixtures/bulma-front.png`,
  '--model',
  'fixture-gen',
  '--models-dir',
  models,
  '--seed',
  '7',
  '--height',
  '1.7',
]);
await cli(['pick', '--workspace', workspace, '--result', 'r1']);
await cli([
  'rig',
  '--track-a',
  '--workspace',
  workspace,
  '--body',
  `${repo}packages/rig/bodies/ubc-male`,
  '--model',
  `${workspace}/canonical/model.glb`,
  '--out',
  `${workspace}/rig`,
]);
await cli(['rig', '--accept', '--workspace', workspace]);
await cli([
  'anim',
  '--enable',
  'idle-loop:4,walk-loop:4,punch-jab:4',
  '--workspace',
  workspace,
]);
await cli([
  'look',
  '--workspace',
  workspace,
  '--style',
  'pixel',
  '--directions',
  '8',
  '--cell',
  '100x128',
  '--ppm',
  '32',
  '--padding',
  '16',
]);

const measurements = [];
for (const superSample of [1, 2, 4] as const) {
  const { look } = await readWorkspace(workspace);
  assert(look, 'the CLI must have recorded its look');
  // The CLI has no supersample flag; use its existing journaled core capability.
  await setLook(workspace, {
    ...look,
    overrides: {
      ...look.overrides,
      temporal: { ...PIXEL.temporal, superSample },
    },
  }, { label: `Baseline ${superSample}x` });

  let coldPages: Record<string, string> | undefined;
  let coldBakeId: string | undefined;
  for (const temperature of ['cold', 'warm'] as const) {
    const before = performance.now();
    const lines = await cli([
      'bake',
      '--workspace',
      workspace,
      '--cache',
      `${out}/cache-s${superSample}`,
      '--only-invalidated',
    ]);
    const wallTimeS = (performance.now() - before) / 1000;
    const character = await readWorkspace(workspace);
    assert(character.lastBakeId, 'bake must record its current output');
    const bakeDir = `${workspace}/bakes/bake-${character.lastBakeId}`;
    const manifest = BakeManifestSchema.parse(
      JSON.parse(await fs.readFile(`${bakeDir}/manifest.json`, 'utf8')),
    );
    assertEquals(
      manifest.frames.length,
      96,
      '3 clips x 4 samples x 8 directions',
    );
    assertEquals(
      manifest.metrics.cacheHitPct,
      temperature === 'cold' ? 0 : 100,
    );
    const pages: Record<string, string> = {};
    for (const page of manifest.atlases) {
      pages[page.png] = await hash(`${bakeDir}/${page.png}`);
    }
    if (temperature === 'cold') {
      coldPages = pages;
      coldBakeId = manifest.bakeId;
    } else {
      assertEquals(
        manifest.bakeId,
        coldBakeId,
        'cache must preserve bake identity',
      );
      assertEquals(
        pages,
        coldPages,
        'warm cache must preserve every shipped AOV page',
      );
    }
    await fs.writeFile(
      `${out}/s${superSample}-${temperature}-manifest.json`,
      canonicalJson(manifest) + '\n',
    );
    measurements.push({
      superSample,
      temperature,
      wallTimeS,
      bakeId: manifest.bakeId,
      frames: manifest.frames.length,
      metrics: manifest.metrics,
      pages,
      warnings: lines.map((s) => JSON.parse(s)).filter((e) => e.t === 'warn'),
    });
    console.log(`${superSample}x ${temperature}: ${wallTimeS.toFixed(3)}s`);
  }
}
const character = await readWorkspace(workspace);
await cli([
  'export',
  '--bake',
  `${workspace}/bakes/bake-${character.lastBakeId}`,
  '--out',
  `${out}/exports`,
  '--targets',
  'godot,aseprite,texturepacker,strips',
]);
const report = {
  sourceCommit,
  startedAt,
  finishedAt: new Date().toISOString(),
  runtime: { node: process.versions.node, v8: process.versions.v8 },
  platform: { os: process.platform, arch: process.arch },
  backend: process.env.SPRITEBOOK_GPU_BACKEND ??
    (process.platform === 'darwin' ? 'metal' : 'vulkan'),
  fixtureBackend: 'fixture-gen (not model inference)',
  coldMeaning:
    'empty frame cache per supersample; fresh CLI process per verb; OS/driver caches untouched',
  inputs,
  measurements,
};
await fs.writeFile(
  `${out}/report.json`,
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  `Control retained at ${out}; copy it before any migration experiment.`,
);
