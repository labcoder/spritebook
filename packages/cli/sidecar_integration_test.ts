import { runProcess } from '../../tools/testing/process.ts';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { assert, assertEquals } from '@std/assert';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import type { JobEvent, JobId } from '@spritebook/schema';
import { SidecarSession } from '@spritebook/core';
import { loadCatalog, runInstallJob } from '@spritebook/registry';
import { runCli } from './dist/mod.js';

const SIDECAR_DIR = decodeURIComponent(
  new URL('../../sidecar', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
);

async function sidecarAvailable(): Promise<boolean> {
  try {
    await fs.stat(`${SIDECAR_DIR}/pyproject.toml`);
    const uv = await runProcess('uv', ['--version']);
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

test('real sidecar: spawn via uv, handshake roster, echo end-to-end', async (t) => {
  if (!(await sidecarAvailable())) {
    t.skip('uv or sidecar/ not available');
    return;
  }
  const out = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  const session = new SidecarSession({ sidecarDir: SIDECAR_DIR });
  try {
    const handle = await session.ensure();
    assertEquals(
      handle.handshake.adapters.map((a) => a.id).sort(),
      [
        'echo',
        'fixture-gen',
        'fixture-retexture',
        'pixal3d',
        'pose-check',
        'rembg',
        'texture-substage',
        'trellis2',
        'trellis2-retexture',
        'unirig',
      ],
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
    assert((await fs.readFile(artifact.path, 'utf8')).includes('3'), 'echo log written');
  } finally {
    await session.dispose();
    await fs.rm(out, { recursive: true });
  }
});

test('ACCEPTANCE: kill sidecar mid-job -> retryable error; retry recovers', async (t) => {
  if (!(await sidecarAvailable())) {
    t.skip('uv or sidecar/ not available');
    return;
  }
  const out = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
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
    await fs.rm(out, { recursive: true });
  }
});

test('ACCEPTANCE: registry-installed weight -> spritebook prep -> cutout + preflight', async (t) => {
  if (!(await sidecarAvailable())) {
    t.skip('uv or sidecar/ not available');
    return;
  }
  const weightPath = process.env['SPRITEBOOK_ITEST_U2NET'];
  if (!weightPath) {
    t.skip('SPRITEBOOK_ITEST_U2NET not set (points at a local u2net.onnx)');
    return;
  }
  const root = await fs.mkdtemp(join(tmpdir(), 'sb-prep-models-'));
  const work = await fs.mkdtemp(join(tmpdir(), 'sb-prep-'));
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
        await fs.copyFile(weightPath, dest);
      },
    }));
    assertEquals(install.at(-1)?.t, 'done', `install: ${JSON.stringify(install.at(-1))}`);

    // input: the committed style fixture's lit frame composited over white —
    // a clear figure on a clean background, no network, no GPU
    const litPath = decodeURIComponent(
      new URL('../style/fixtures/aov/frames/d00_f000_lit.png', import.meta.url).pathname
        .replace(/^\/([A-Za-z]:)/, '$1'),
    );
    const lit = decodePng(new Uint8Array(await fs.readFile(litPath)));
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
    await fs.writeFile(
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

    const cutout = decodePng(new Uint8Array(await fs.readFile(`${work}/out/cutout.png`)));
    assertEquals(cutout.channels, 4, 'cutout is RGBA');
    const cpx = cutout.data as Uint8Array;
    let opaque = 0, clear = 0;
    for (let p = 0; p < cutout.width * cutout.height; p++) {
      if (cpx[p * 4 + 3] > 128) opaque++;
      else if (cpx[p * 4 + 3] === 0) clear++;
    }
    assert(opaque > 500, `subject present in the cutout (${opaque} opaque px)`);
    assert(clear > 500, `background actually removed (${clear} clear px)`);

    const preflight = JSON.parse(await fs.readFile(`${work}/out/preflight.json`, 'utf8'));
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
    await fs.rm(root, { recursive: true });
    await fs.rm(work, { recursive: true });
  }
});

test('doctor --sidecar: boots, handshakes, reports the roster, exits by health', async (t) => {
  // P4-T1: the studio status bar consumes exactly this document, so the test
  // asserts the CONTRACT of the report, not incidental fields.
  if (!(await sidecarAvailable())) {
    t.skip('uv or sidecar/ not available');
    return;
  }
  const lines: string[] = [];
  const code = await runCli(['doctor', '--sidecar', '--json'], {
    stdout: (s) => lines.push(s),
    stderr: (s) => lines.push(s),
  });
  assertEquals(lines.length, 1, 'doctor --json is ONE document line');
  const report = JSON.parse(lines[0]);
  assert(report.sidecar, 'the report carries a sidecar section when asked');
  assert(report.sidecar.ok, `sidecar exam failed: ${report.sidecar.error}`);
  assert(report.sidecar.contractVersion >= 1);
  assert(typeof report.sidecar.python === 'string' && report.sidecar.python.length > 0);
  const ids = (report.sidecar.adapters as { id: string }[]).map((a) => a.id);
  assert(ids.length > 0, 'the roster is not empty');
  assert(ids.includes('fixture-gen'), `fixture-gen missing from roster: ${ids.join(', ')}`);
  // exit composes render health AND sidecar health; on this machine both hold
  assertEquals(code, 0, 'healthy exam exits 0');

  // and WITHOUT the flag the report must not mention the sidecar at all -
  // the section appearing unasked would mean doctor boots python on every run
  const plain: string[] = [];
  await runCli(['doctor', '--json'], { stdout: (s) => plain.push(s), stderr: () => {} });
  assert(!('sidecar' in JSON.parse(plain[0])), 'no sidecar section unless asked');
});
