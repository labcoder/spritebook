/**
 * `spritebook doctor` — the GPU/adapter/backend health report (P2-T4). Prints
 * the product + render-pipeline versions, the backend env, adapter identity,
 * the D-023 render signature (what cache keys carry), the limits the renderer
 * depends on, and a clear-pass render probe. Exit code 0 only when an adapter
 * exists AND the probe passes — a doctor that finds illness says so loudly.
 *
 * `--json` emits ONE JSON document line (documented exception to the NDJSON
 * job-event discipline: doctor is a diagnostic snapshot, not a job stream).
 */
import { renderDiagnostics } from '@spritebook/render';
import { SPRITEBOOK_VERSION } from './version.ts';
import type { CliIo } from './mod.ts';

export async function runDoctor(args: string[], io: CliIo): Promise<number> {
  const json = args.includes('--json');
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

  const report = {
    spritebook: SPRITEBOOK_VERSION,
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    platform: `${Deno.build.os}-${Deno.build.arch}`,
    ...diag,
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
  }
  return diag.available && diag.probe?.ok ? 0 : 1;
}
