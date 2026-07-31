/**
 * `spritebook doctor` — the GPU/adapter/backend health report (P2-T4). Prints
 * the product + render-pipeline versions, the backend env, adapter identity,
 * the D-023 render signature (what cache keys carry), the limits the renderer
 * depends on, and a clear-pass render probe. Exit code 0 only when an adapter
 * exists AND the probe passes — a doctor that finds illness says so loudly.
 *
 * `--sidecar` extends the exam: boot the Python sidecar exactly as a gen job
 * would (same dir resolution: SPRITEBOOK_SIDECAR_DIR or the repo default),
 * perform the contract handshake, report version + adapter roster, and shut
 * it down. Added for P4-T1 — the studio's status bar is this verb's client,
 * per the capability-moves-to-core-first law. A sidecar failure fails the
 * exit code like any other illness.
 *
 * `--json` emits ONE JSON document line (documented exception to the NDJSON
 * job-event discipline: doctor is a diagnostic snapshot, not a job stream).
 */
import { renderDiagnostics } from '@spritebook/render';
import { SidecarSession } from '@spritebook/core';
import { SPRITEBOOK_VERSION } from './version.ts';
import type { CliIo } from './mod.ts';

/** The same resolution gen/pick use, minus the per-call flag: doctor examines
 * the DEFAULT configuration, so an env override is the only knob. */
function defaultSidecarDir(): string {
  const env = Deno.env.get('SPRITEBOOK_SIDECAR_DIR');
  if (env) return env;
  return decodeURIComponent(
    new URL('../../sidecar', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  );
}

interface SidecarReport {
  ok: boolean;
  dir: string;
  contractVersion?: number;
  sidecarVersion?: string;
  python?: string;
  adapters?: { id: string; kind: string; version: string }[];
  error?: string;
}

async function examineSidecar(): Promise<SidecarReport> {
  const dir = defaultSidecarDir();
  const session = new SidecarSession({ sidecarDir: dir });
  try {
    const handle = await session.ensure();
    const h = handle.handshake;
    return {
      ok: true,
      dir,
      contractVersion: h.contractVersion,
      sidecarVersion: h.sidecarVersion,
      python: h.python,
      adapters: h.adapters.map((a) => ({ id: a.id, kind: a.kind, version: a.version })),
    };
  } catch (err) {
    return { ok: false, dir, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await session.dispose();
  }
}

export async function runDoctor(args: string[], io: CliIo): Promise<number> {
  const json = args.includes('--json');
  const wantSidecar = args.includes('--sidecar');
  let diag;
  try {
    diag = await renderDiagnostics({ probe: true });
  } catch (err) {
    // SPRITEBOOK_REQUIRE_GPU turns a missing adapter into a throw — report it
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      io.stdout(JSON.stringify({ spritebook: SPRITEBOOK_VERSION, error: message }));
    } else {
      io.stderr(`doctor: ${message}`);
    }
    return 1;
  }

  const sidecar = wantSidecar ? await examineSidecar() : undefined;
  const report = {
    spritebook: SPRITEBOOK_VERSION,
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    platform: `${Deno.build.os}-${Deno.build.arch}`,
    ...diag,
    ...(sidecar ? { sidecar } : {}),
  };

  if (json) {
    io.stdout(JSON.stringify(report));
  } else {
    io.stdout(`SpriteBook ${SPRITEBOOK_VERSION}`);
    io.stdout(`deno ${report.deno} - v8 ${report.v8} - ${report.platform}`);
    io.stdout(`render pipeline ${diag.version}`);
    io.stdout(`backend env: DENO_WEBGPU_BACKEND=${diag.backendEnv}`);
    if (!diag.available) {
      io.stdout('adapter: NONE - GPU rendering unavailable');
      for (const h of diag.hints ?? []) io.stdout(`  hint: ${h}`);
    } else {
      const a = diag.adapter ?? {};
      const desc = typeof a.description === 'string' && a.description.length > 0
        ? a.description
        : '(no description)';
      io.stdout(`adapter: ${desc} (vendor ${a.vendor ?? '?'}, device ${a.device ?? '?'})`);
      io.stdout(`render signature: ${diag.signature}`);
      io.stdout(`features: ${(diag.features ?? []).join(', ') || '(none)'}`);
      const l = diag.limits ?? {};
      io.stdout(
        `limits: ${Object.entries(l).map(([k, v]) => `${k}=${v}`).join(' ')}`,
      );
      if (diag.probe?.ok) {
        io.stdout(`render probe: OK (checksum ${diag.probe.checksum})`);
      } else {
        io.stdout(`render probe: FAILED - ${diag.probe?.error ?? 'unknown'}`);
      }
    }
    if (sidecar) {
      if (sidecar.ok) {
        io.stdout(
          `sidecar: OK - contract v${sidecar.contractVersion}, ` +
            `${sidecar.sidecarVersion} on python ${sidecar.python} (${sidecar.dir})`,
        );
        for (const a of sidecar.adapters ?? []) {
          io.stdout(`  adapter: ${a.id} (${a.kind}) v${a.version}`);
        }
      } else {
        io.stdout(`sidecar: FAILED - ${sidecar.error} (${sidecar.dir})`);
      }
    }
  }
  const renderHealthy = diag.available && diag.probe?.ok;
  return renderHealthy && (sidecar?.ok ?? true) ? 0 : 1;
}
