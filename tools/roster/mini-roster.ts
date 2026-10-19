import { promises as fs } from 'node:fs';
/**
 * The mini-roster script (P3-T4 acceptance): ten characters, generated,
 * picked, baked and exported by ONE command with nobody watching.
 *
 *   node tools/run.mjs tools/roster/mini-roster.ts --out <dir> [--count 10]
 *
 * This is the honest form of "roster XL": the point is not that ten is a big
 * number, it is that the per-character path has no interactive step left in
 * it. Anything that needs a human — picking between generation results,
 * nudging a joint, accepting a rig — has a non-interactive default here, and
 * if any of them did not, this script could not exist.
 *
 * The backend is `fixture-gen` (synthetic, weightless, deterministic) because
 * that is the only image-to-3D backend that runs on any machine today; see
 * D-028 for why TRELLIS.2 does not. Every OTHER stage is the real one — real
 * border, real bake, real packer, real exporters — so the number this prints
 * is a true measure of everything SpriteBook controls, and excludes exactly
 * one thing: real image->3D inference. It says so when it prints.
 */
import { runGenJob, runPickJob } from '@spritebook/gen';
import { runBakeJob } from '@spritebook/pack';
import { runExportJob } from '@spritebook/export';
import { PIXEL } from '@spritebook/style';
import type { CameraPreset, JobEvent } from '@spritebook/schema';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  const v = i < 0 ? undefined : args[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
};

const outRoot = flag('out') ?? './roster-out';
const count = Number(flag('count') ?? '10');
const sidecarDir = flag('sidecar') ??
  decodeURIComponent(
    new URL('../../sidecar', import.meta.url).pathname.replace(
      /^\/([A-Za-z]:)/,
      '$1',
    ),
  );
const modelsRoot = flag('models-dir');

const CAM: CameraPreset = {
  id: 'roster-30x8',
  elevationDeg: 30,
  directions: 8,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32,
  cellPx: { w: 64, h: 64 },
  paddingPx: 6,
  pivot: 'feet-baseline',
  orthographic: true,
};

/** A deterministic cut-out per character, so the roster is reproducible. */
function cutout(seed: number, w = 128, h = 192): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  const build = 0.18 + (seed % 5) * 0.03; // different silhouettes per character
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = w / 2;
      const inBody = y < h * 0.22
        ? Math.hypot(x - cx, y - h * 0.13) < w * 0.16
        : y < h * 0.68
        ? Math.abs(x - cx) < w * build
        : Math.abs(x - cx) < w * build * 0.7;
      if (!inBody) continue;
      const at = (y * w + x) * 4;
      data[at] = (x * 2 + seed * 40) % 256;
      data[at + 1] = (y * 3 + seed * 25) % 256;
      data[at + 2] = 180;
      data[at + 3] = 255;
    }
  }
  return data;
}

async function drain(
  events: AsyncIterable<JobEvent>,
  what: string,
): Promise<JobEvent[]> {
  const out: JobEvent[] = [];
  for await (const e of events) {
    out.push(e);
    if (e.t === 'error') {
      throw new Error(`${what} failed [${e.code}]: ${e.message}`);
    }
  }
  return out;
}

// tools/ sits outside the workspace members, so name the pinned npm
// specifier directly rather than relying on a member's import map
const { encode: encodePng } = await import('fast-png');
await fs.mkdir(outRoot, { recursive: true });

const t0 = performance.now();
const perCharacter: number[] = [];

for (let i = 1; i <= count; i++) {
  const id = `roster-${String(i).padStart(2, '0')}`;
  const ws = `${outRoot}/${id}`;
  const c0 = performance.now();

  const imagePath = `${outRoot}/${id}-source.png`;
  await fs.writeFile(
    imagePath,
    encodePng({ width: 128, height: 192, data: cutout(i) }),
  );

  // 1. generate — ONE result, which is the non-interactive default
  const gen = await drain(
    runGenJob({
      jobId: 'roster-gen',
      characterId: id as never,
      workspace: ws,
      imagePath,
      modelId: 'fixture-gen',
      seed: i,
      params: {},
      sidecarDir,
      ...(modelsRoot ? { modelsRoot } : {}),
    }),
    `${id} gen`,
  );
  void gen;

  // 2. pick it — with one result there is nothing to choose between, which is
  // exactly why the roster path can run unattended
  await drain(
    runPickJob({ jobId: 'roster-pick', workspace: ws, resultId: 'r1' }),
    `${id} pick`,
  );

  // 3. bake + 4. export, the real pipeline
  const bake = await drain(
    runBakeJob({
      jobId: 'roster-bake',
      characterId: id,
      modelPath: `${ws}/canonical/model.glb`,
      camera: CAM,
      style: PIXEL,
      frames: 2,
      outRoot: `${ws}/bakes`,
    }),
    `${id} bake`,
  );
  const bakeDir = (bake.find((e) => e.t === 'artifact' && e.kind === 'bake-dir') as {
    path: string;
  }).path;

  await drain(
    runExportJob({
      jobId: 'roster-export',
      bakeDir,
      outDir: `${ws}/export`,
      targets: ['godot', 'strips'],
    }),
    `${id} export`,
  );

  const dt = (performance.now() - c0) / 1000;
  perCharacter.push(dt);
  console.log(`${id}: ${dt.toFixed(2)}s`);
}

const total = (performance.now() - t0) / 1000;
const mean = perCharacter.reduce((a, b) => a + b, 0) / perCharacter.length;
console.log('');
console.log(
  `roster of ${count}: ${total.toFixed(2)}s total, ${mean.toFixed(2)}s per character`,
);
console.log(
  'measures: image -> canonical glb (border) -> bake (render/style/pack) -> export.',
);
console.log(
  'EXCLUDES: real image->3D inference (fixture-gen is synthetic; see D-028) and rigging.',
);
