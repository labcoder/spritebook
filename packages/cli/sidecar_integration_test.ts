/**
 * P3-T2 acceptance against the REAL Python sidecar (gated on uv + the sidecar
 * checkout; the prep leg additionally needs the u2net weight via
 * SPRITEBOOK_ITEST_U2NET so no test ever touches the network):
 *  1. real-process contract — spawn via uv, handshake roster, echo end-to-end;
 *  2. kill-and-restart mid-job — core surfaces a RETRYABLE error and the next
 *     run() recovers on a fresh process (the roadmap acceptance, literally);
 *  3. prep end-to-end — install rembg-u2net through the registry (hash
 *     verified against the catalog pin), then `spritebook prep` produces a
 *     real cutout + preflight through the border.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import type { JobEvent, JobId } from '@spritebook/schema';
import { SidecarSession } from '@spritebook/core';
import { loadCatalog, runInstallJob } from '@spritebook/registry';
import { runCli } from './mod.ts';

const SIDECAR_DIR = decodeURIComponent(
  new URL('../../sidecar', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
);

async function sidecarAvailable(): Promise<boolean> {
  try {
    await Deno.stat(`${SIDECAR_DIR}/pyproject.toml`);
    const uv = await new Deno.Command('uv', {
      args: ['--version'],
      stdout: 'null',
      stderr: 'null',
      stdin: 'null',
    }).output();
    return uv.success;
  } catch {
    return false;
  }
}

async function collect(it: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const out: JobEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

Deno.test('real sidecar: spawn via uv, handshake roster, echo end-to-end', async () => {
  if (!(await sidecarAvailable())) {
    console.log('skip: uv or sidecar/ not available');
    return;
  }
  const out = await Deno.makeTempDir();
  const session = new SidecarSession({ sidecarDir: SIDECAR_DIR });
  try {
    const handle = await session.ensure();
    assertEquals(
      handle.handshake.adapters.map((a) => a.id).sort(),
      ['echo', 'fixture-gen', 'pose-check', 'rembg', 'texture-substage', 'unirig'],
      'the announced roster',
    );
    const events = await collect(session.run({
      jobId: 'itest-echo' as JobId,
      kind: 'echo',
      params: { steps: 3, delayMs: 10, outDir: out },
    }));
    assertEquals(
      events.map((e) => e.t),
      ['queued', 'started', 'progress', 'progress', 'progress', 'artifact', 'done'],
    );
    const artifact = events.find((e) => e.t === 'artifact') as { path: string };
    assert((await Deno.readTextFile(artifact.path)).includes('3'), 'echo log written');
  } finally {
    await session.dispose();
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('ACCEPTANCE: kill sidecar mid-job -> retryable error; retry recovers', async () => {
  if (!(await sidecarAvailable())) {
    console.log('skip: uv or sidecar/ not available');
    return;
  }
  const out = await Deno.makeTempDir();
  const session = new SidecarSession({ sidecarDir: SIDECAR_DIR });
  try {
    const first = await session.ensure();
    const killedPid = first.pid;

    // dieAt hard-exits the python process (os._exit) right after step 2's
    // progress event — a real mid-stream crash, no kill permission needed
    const seen: JobEvent[] = [];
    for await (
      const e of session.run({
        jobId: 'itest-kill' as JobId,
        kind: 'echo',
        params: { steps: 200, delayMs: 10, outDir: out, dieAt: 2 },
      })
    ) {
      seen.push(e);
    }
    const last = seen.at(-1)!;
    assert(last.t === 'error', `terminal event is an error (got ${last.t})`);
    if (last.t === 'error') {
      assertEquals(last.code, 'sidecar-died');
      assertEquals(last.retryable, true, 'death mid-job MUST be retryable');
    }

    // the retry: a plain second run() — the supervisor respawns and completes
    const retry = await collect(session.run({
      jobId: 'itest-retry' as JobId,
      kind: 'echo',
      params: { steps: 2, delayMs: 0, outDir: out },
    }));
    assertEquals(retry.at(-1)?.t, 'done', 'retry after death completes');
    const second = await session.ensure();
    assert(second.pid !== killedPid, 'recovery ran on a FRESH process');
  } finally {
    await session.dispose();
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('ACCEPTANCE: registry-installed weight -> spritebook prep -> cutout + preflight', async () => {
  if (!(await sidecarAvailable())) {
    console.log('skip: uv or sidecar/ not available');
    return;
  }
  const weightPath = Deno.env.get('SPRITEBOOK_ITEST_U2NET');
  if (!weightPath) {
    console.log('skip: SPRITEBOOK_ITEST_U2NET not set (points at a local u2net.onnx)');
    return;
  }
  const root = await Deno.makeTempDir({ prefix: 'sb-prep-models-' });
  const work = await Deno.makeTempDir({ prefix: 'sb-prep-' });
  try {
    // install through the REAL job (gates, staging, receipt) — the fetcher is
    // a local copy, but the hash still verifies against the catalog pin, so a
    // wrong file fails exactly like a corrupt download would
    const catalog = await loadCatalog();
    const install = await collect(runInstallJob({
      jobId: 'itest-install',
      catalog,
      root,
      modelId: 'rembg-u2net',
      fetcher: async (_url, dest) => {
        await Deno.copyFile(weightPath, dest);
      },
    }));
    assertEquals(install.at(-1)?.t, 'done', `install: ${JSON.stringify(install.at(-1))}`);

    // input: the committed style fixture's lit frame composited over white —
    // a clear figure on a clean background, no network, no GPU
    const litPath = decodeURIComponent(
      new URL('../style/fixtures/aov/frames/d00_f000_lit.png', import.meta.url).pathname
        .replace(/^\/([A-Za-z]:)/, '$1'),
    );
    const lit = decodePng(await Deno.readFile(litPath));
    const px = lit.data as Uint8Array;
    const rgba = new Uint8Array(lit.width * lit.height * 4);
    for (let p = 0; p < lit.width * lit.height; p++) {
      const a = px[p * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) {
        rgba[p * 4 + c] = Math.round(px[p * 4 + c] * a + 255 * (1 - a));
      }
      rgba[p * 4 + 3] = 255;
    }
    const inputPath = `${work}/input.png`;
    await Deno.writeFile(
      inputPath,
      encodePng({ width: lit.width, height: lit.height, data: rgba }),
    );

    // the verb, end to end
    const lines: string[] = [];
    const code = await runCli([
      'prep',
      '--image',
      inputPath,
      '--out',
      `${work}/out`,
      '--models-dir',
      root,
      '--sidecar',
      SIDECAR_DIR,
      '--json',
    ], { stdout: (l) => lines.push(l), stderr: (l) => lines.push(l) });
    assertEquals(code, 0, `prep exit 0; events:\n${lines.join('\n')}`);

    const cutout = decodePng(await Deno.readFile(`${work}/out/cutout.png`));
    assertEquals(cutout.channels, 4, 'cutout is RGBA');
    const cpx = cutout.data as Uint8Array;
    let opaque = 0, clear = 0;
    for (let p = 0; p < cutout.width * cutout.height; p++) {
      if (cpx[p * 4 + 3] > 128) opaque++;
      else if (cpx[p * 4 + 3] === 0) clear++;
    }
    assert(opaque > 500, `subject present in the cutout (${opaque} opaque px)`);
    assert(clear > 500, `background actually removed (${clear} clear px)`);

    const preflight = JSON.parse(await Deno.readTextFile(`${work}/out/preflight.json`));
    assertEquals(
      preflight.checks.map((c: { id: string }) => c.id),
      ['loaded', 'cutout', 'pose', 'resolution'],
      'pose heuristic v1 advisory checks, in order',
    );
    for (const c of preflight.checks) {
      assert(c.status === 'ok' || c.status === 'warn', 'advisory statuses only');
      assert(typeof c.message === 'string' && c.message.length > 0);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(work, { recursive: true });
  }
});
