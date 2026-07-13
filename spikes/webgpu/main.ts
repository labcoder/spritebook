// P0-T2 — headless WebGPU spike (see docs/internal/roadmap/p0.md).
// Throwaway by contract; the MEASUREMENTS are the deliverable.
//
//   deno task spike:webgpu                 full suite (bar + soak + 512px + shear + determinism)
//   deno task spike:webgpu -- --mode=bar   official pass-bar batch only
//   deno task spike:webgpu -- --mode=fault fault-injection postscript (may abort the process
//                                          by design — run it last, in its own invocation)
//
// Cross-process determinism: every full/bar run writes out/hashes-latest.json;
// if that file already exists from a previous invocation it is compared first.

import { encode as encodePng } from 'npm:fast-png@6.2.0';
import { loadAsset } from './asset.ts';
import { initGPU, SpikeRenderer } from './renderer.ts';

const SIZE = 128;
const BAR_FRAMES = 100;
const SOAK_FRAMES = 1000;
const PASS_BAR_FPS = 5;

const here = (p: string) => new URL(p, import.meta.url);
const outDir = here('./out/');
const framesDir = here('./out/frames/');
const hashesPath = here('./out/hashes-latest.json');

const mode = (Deno.args.find((a) => a.startsWith('--mode=')) ?? '--mode=full').slice(7);

async function sha256hex(...parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    joined.set(p, o);
    o += p.length;
  }
  const digest = await crypto.subtle.digest('SHA-256', joined);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function depthToPng16(dep: Uint8Array, width: number, height: number): Uint8Array {
  const f32 = new Float32Array(dep.buffer, dep.byteOffset, width * height);
  const g16 = new Uint16Array(width * height);
  for (let i = 0; i < g16.length; i++) {
    g16[i] = Math.min(65535, Math.max(0, Math.round(f32[i] * 65535)));
  }
  return encodePng({ width, height, data: g16, channels: 1, depth: 16 });
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

async function main() {
  console.log(`deno ${Deno.version.deno} · v8 ${Deno.version.v8}`);
  const backendEnv = Deno.env.get('DENO_WEBGPU_BACKEND') ?? '(unset — wgpu default)';
  console.log(`DENO_WEBGPU_BACKEND=${backendEnv}`);

  const gpu = await initGPU();
  console.log(`adapter.info: ${JSON.stringify(gpu.adapterInfo)}`);
  console.log(`device features: ${gpu.features.join(', ') || '(none)'}`);

  if (mode === 'fault') {
    await faultInjection(gpu.device);
    return;
  }

  const asset = await loadAsset(here('./assets/skinned-column.glb'));
  console.log(
    `asset: ${asset.positions.length / 3} verts, ${
      asset.indices.length / 3
    } tris, ${asset.jointCount} joints`,
  );
  const shaderSrc = await Deno.readTextFile(here('./shaders.wgsl'));

  await Deno.mkdir(framesDir, { recursive: true });

  // surface setup-time validation errors as failures, not mystery output
  gpu.device.pushErrorScope('validation');
  const renderer = new SpikeRenderer(gpu.device, asset, shaderSrc, SIZE, SIZE);
  const setupError = await gpu.device.popErrorScope();
  if (setupError) throw new Error(`validation error during setup: ${setupError.message}`);

  const report: Record<string, unknown> = {
    denoVersion: Deno.version.deno,
    backendEnv,
    adapterInfo: gpu.adapterInfo,
    mode,
  };

  // ---- previous-invocation hashes (cross-process determinism) -------------
  let previousHashes: string[] | null = null;
  try {
    previousHashes = JSON.parse(await Deno.readTextFile(hashesPath));
  } catch { /* first invocation */ }

  // ---- 1. official pass-bar batch: 100 frames @128px, 2 attachments, PNGs --
  console.log(
    `\n[1/6] pass-bar batch: ${BAR_FRAMES} frames @ ${SIZE}px, MRT lit+depth, PNGs written`,
  );
  const run1Hashes: string[] = [];
  const bar = await renderer.runBatch({
    frames: BAR_FRAMES,
    consume: async (frame, lit, dep) => {
      run1Hashes.push(await sha256hex(lit, dep));
      const litPng = encodePng({ width: SIZE, height: SIZE, data: lit.slice() });
      const depPng = depthToPng16(dep, SIZE, SIZE);
      const tag = String(frame).padStart(4, '0');
      await Deno.writeFile(new URL(`./frame-${tag}-lit.png`, framesDir), litPng);
      await Deno.writeFile(new URL(`./frame-${tag}-depth.png`, framesDir), depPng);
    },
  });
  report.bar = bar;
  console.log(
    `  ${fmt(bar.fps)} frames/s end-to-end (${fmt(bar.wallMs)} ms wall, map-wait ${
      fmt(bar.mapWaitMs)
    } ms, ` +
      `png+write ${fmt(bar.consumeMs)} ms) · readback ${fmt(bar.readbackMBps, 2)} MB/s (unpadded)`,
  );
  console.log(`  pass bar ≥${PASS_BAR_FPS} f/s: ${bar.fps >= PASS_BAR_FPS ? 'PASS' : 'FAIL'}`);

  // ---- 2. render+readback only (no PNG), and in-process determinism -------
  console.log(`\n[2/6] determinism: re-render the same ${BAR_FRAMES} frames (hash-only, no PNG)`);
  const run2Hashes: string[] = [];
  const noPng = await renderer.runBatch({
    frames: BAR_FRAMES,
    consume: async (_f, lit, dep) => {
      run2Hashes.push(await sha256hex(lit, dep));
    },
  });
  const inProcessDeterministic = run1Hashes.length === run2Hashes.length &&
    run1Hashes.every((h, i) => h === run2Hashes[i]);
  report.renderReadbackOnly = noPng;
  report.inProcessDeterministic = inProcessDeterministic;
  console.log(
    `  render+readback-only: ${fmt(noPng.fps)} frames/s · readback ${
      fmt(noPng.readbackMBps, 2)
    } MB/s`,
  );
  console.log(
    `  same-process double render identical bytes: ${inProcessDeterministic ? 'PASS' : 'FAIL'}`,
  );

  let crossProcessDeterministic: boolean | null = null;
  if (previousHashes) {
    crossProcessDeterministic = previousHashes.length === run1Hashes.length &&
      previousHashes.every((h, i) => h === run1Hashes[i]);
    console.log(
      `  cross-process (vs previous invocation): ${crossProcessDeterministic ? 'PASS' : 'FAIL'}`,
    );
  } else {
    console.log('  cross-process: no previous hashes file — run again to compare');
  }
  report.crossProcessDeterministic = crossProcessDeterministic;
  await Deno.writeTextFile(hashesPath, JSON.stringify(run1Hashes));

  // ---- 3. width-100 shear test (row padding: 400 bytes -> padded 512) ------
  console.log('\n[3/6] shear test @ width 100 (padded-strip path vs per-row reference path)');
  const shearRenderer = new SpikeRenderer(gpu.device, asset, shaderSrc, 100, SIZE);
  const viaPadded = await shearRenderer.renderSinglePadded(0);
  const viaRows = await shearRenderer.renderSingleRowByRow(0);
  const shearOk = viaPadded.length === viaRows.length &&
    viaPadded.every((b, i) => b === viaRows[i]);
  await Deno.writeFile(
    new URL('./shear-100px-lit.png', outDir),
    encodePng({ width: 100, height: SIZE, data: viaPadded }),
  );
  // sanity: silhouette must have visible alpha and be roughly centered
  let alphaCount = 0, cx = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < 100; x++) {
      if (viaPadded[(y * 100 + x) * 4 + 3] > 0) {
        alphaCount++;
        cx += x;
      }
    }
  }
  const centroidX = alphaCount ? cx / alphaCount : NaN;
  report.shear = { bytesIdentical: shearOk, alphaPixels: alphaCount, centroidX };
  console.log(
    `  bytes identical: ${shearOk ? 'PASS' : 'FAIL'} · silhouette ${alphaCount} px, centroid x=${
      fmt(centroidX)
    }`,
  );

  if (mode === 'bar') {
    finish(report);
    return;
  }

  // ---- 4. sustained soak: 1000 frames with memory sampling ----------------
  console.log(
    `\n[4/6] sustained soak: ${SOAK_FRAMES} frames @ ${SIZE}px, PNG encode (write every 100th)`,
  );
  const memSamples: { frame: number; rss: number; heapUsed: number; external: number }[] = [];
  const sampleMem = (frame: number) => {
    const m = Deno.memoryUsage();
    memSamples.push({ frame, rss: m.rss, heapUsed: m.heapUsed, external: m.external });
  };
  sampleMem(0);
  const soak = await renderer.runBatch({
    frames: SOAK_FRAMES,
    consume: async (frame, lit, dep) => {
      const litPng = encodePng({ width: SIZE, height: SIZE, data: lit.slice() });
      const depPng = depthToPng16(dep, SIZE, SIZE);
      if (frame % 100 === 0) {
        await Deno.writeFile(
          new URL(`./soak-${String(frame).padStart(4, '0')}-lit.png`, framesDir),
          litPng,
        );
        await Deno.writeFile(
          new URL(`./soak-${String(frame).padStart(4, '0')}-depth.png`, framesDir),
          depPng,
        );
      }
    },
    onFrameDone: (n) => {
      if ((n + 1) % 100 === 0) sampleMem(n + 1);
    },
  });
  report.soak = soak;
  report.memSamples = memSamples;
  const rssFirst = memSamples[1]?.rss ?? memSamples[0].rss;
  const rssLast = memSamples[memSamples.length - 1].rss;
  const rssGrowthPct = ((rssLast - rssFirst) / rssFirst) * 100;
  report.rssGrowthPct = rssGrowthPct;
  console.log(
    `  sustained: ${fmt(soak.fps)} frames/s end-to-end · readback ${
      fmt(soak.readbackMBps, 2)
    } MB/s`,
  );
  console.log(
    `  RSS ${fmt(rssFirst / 1e6)} MB -> ${fmt(rssLast / 1e6)} MB (${
      fmt(rssGrowthPct)
    }% after warmup) over ${SOAK_FRAMES} frames`,
  );
  // projections against the PRD workloads (devil's-advocate addition)
  const proj = (frames: number) => frames / soak.fps / 3600;
  report.projections = { frames64k_hours: proj(64_000), frames192k_hours: proj(192_000) };
  console.log(
    `  projection at sustained rate: 64k frames = ${fmt(proj(64_000), 2)} h · 192k frames = ${
      fmt(proj(192_000), 2)
    } h`,
  );

  // ---- 5. 512px batch (supersampling headroom probe) -----------------------
  console.log('\n[5/6] 512px batch: 100 frames, MRT, PNG encode (no writes)');
  const r512 = new SpikeRenderer(gpu.device, asset, shaderSrc, 512, 512);
  let wrote512 = false;
  const b512 = await r512.runBatch({
    frames: 100,
    consume: async (_frame, lit, dep) => {
      const litPng = encodePng({ width: 512, height: 512, data: lit.slice() });
      depthToPng16(dep, 512, 512);
      if (!wrote512) {
        wrote512 = true;
        await Deno.writeFile(new URL('./sample-512-lit.png', outDir), litPng);
      }
    },
  });
  report.batch512 = b512;
  console.log(
    `  ${fmt(b512.fps)} frames/s end-to-end · readback ${fmt(b512.readbackMBps, 2)} MB/s`,
  );

  console.log(
    '\n[6/6] done — run `deno task spike:webgpu -- --mode=fault` separately for the panic probe',
  );
  finish(report);
}

function finish(report: Record<string, unknown>) {
  const path = new URL(`./metrics-${Date.now()}.json`, outDir);
  Deno.writeTextFileSync(path, JSON.stringify(report, null, 2));
  console.log(`\nmetrics written: ${path.pathname}`);
  console.log('SPIKE_REPORT_JSON ' + JSON.stringify(report));
}

/**
 * Fault-injection postscript (untimed, knowledge output): does using a
 * destroyed texture surface as a catchable error, a device.lost, or a process
 * abort? The answer shapes the P2 bake supervisor design.
 */
async function faultInjection(device: GPUDevice) {
  console.log('\nfault injection: render pass over a destroyed texture, inside try/catch');
  const tex = device.createTexture({
    size: { width: 16, height: 16 },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const view = tex.createView();
  tex.destroy();
  try {
    device.pushErrorScope('validation');
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
    const err = await device.popErrorScope();
    await device.queue.onSubmittedWorkDone();
    console.log(`  survived. validation error captured: ${err ? err.message : '(none)'}`);
    console.log(
      '  verdict: catchable — a bake job can convert this to a retryable error in-process',
    );
  } catch (e) {
    console.log(`  threw (catchable): ${(e as Error).message}`);
    console.log(
      '  verdict: catchable — a bake job can convert this to a retryable error in-process',
    );
  }
  // if the process aborts before this line prints, the fault is NOT catchable:
  console.log('fault injection completed without process death');
}

await main();
