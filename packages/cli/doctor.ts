import { resourcePath } from '@spritebook/core';

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
import {
  defaultModelsRoot,
  detectAppDataVirtualization,
  detectGpuMemory,
  detectVramGb,
  hostResources,
  type VirtualizationReport,
} from '@spritebook/registry';
import { SPRITEBOOK_VERSION } from './version.ts';
import type { CliIo } from './mod.ts';

/** The same resolution gen/pick use, minus the per-call flag: doctor examines
 * the DEFAULT configuration, so an env override is the only knob. */
function defaultSidecarDir(): string {
  const env = process.env['SPRITEBOOK_SIDECAR_DIR'];
  if (env) return env;
  return resourcePath('sidecar');
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
  // D-039: where model installs land, and whether THIS process even sees the
  // real filesystem there - the split-brain incident's whole story in two
  // lines. Never throws; an unresolvable root is reported, not fatal.
  let modelsRoot: string | null = null;
  try {
    modelsRoot = defaultModelsRoot();
  } catch { /* no LOCALAPPDATA/HOME - the report line says so */ }
  const virtualization: VirtualizationReport = await detectAppDataVirtualization();
  // the exam is where the GUI learns the card's capacity (W6: a 24 GiB card
  // should not default to lowVram) - null when nvidia-smi is absent
  const [vramGb, resources, gpuMemory] = await Promise.all([
    detectVramGb(),
    hostResources(modelsRoot ?? undefined),
    detectGpuMemory(),
  ]);
  const report = {
    spritebook: SPRITEBOOK_VERSION,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: `${(process.platform === 'win32' ? 'windows' : process.platform)}-${process.arch}`,
    vramGb,
    resources,
    gpuMemory,
    models: { root: modelsRoot, virtualization },
    ...diag,
    ...(sidecar ? { sidecar } : {}),
  };

  if (json) {
    io.stdout(JSON.stringify(report));
  } else {
    io.stdout(`SpriteBook ${SPRITEBOOK_VERSION}`);
    io.stdout(`node ${report.node} - v8 ${report.v8} - ${report.platform}`);
    io.stdout(`vram: ${vramGb === null ? 'unknown (no nvidia-smi)' : `${vramGb} GiB detected`}`);
    const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
    io.stdout(
      `ram: ${gib(resources.ram.freeBytes)} GiB free of ${gib(resources.ram.totalBytes)} GiB; ` +
        `${gib(resources.ram.processAvailableBytes)} GiB available to this process`,
    );
    io.stdout(
      `model destination free: ${
        resources.diskFreeBytes === null ? 'unmeasured' : `${gib(resources.diskFreeBytes)} GiB`
      }`,
    );
    io.stdout(
      `models root: ${modelsRoot ?? '(unresolvable - set SPRITEBOOK_MODELS_DIR)'}`,
    );
    if (gpuMemory === null) io.stdout('NVIDIA memory inventory: unmeasured');
    for (const device of gpuMemory ?? []) {
      io.stdout(
        `NVIDIA GPU ${device.index} (${device.uuid}): ${gib(device.freeBytes)} GiB free of ${
          gib(device.totalBytes)
        } GiB`,
      );
    }
    if (gpuMemory?.length) {
      io.stdout(
        'Memory is a snapshot; backend device selection and kernel support need separate checks.',
      );
    }
    if (virtualization.virtualized) {
      io.stdout(
        `  CONTAINED: MSIX AppData virtualization is active - package ` +
          `"${virtualization.pkg}" owns a private overlay of %LOCALAPPDATA%, so this ` +
          `process and unpackaged processes see DIFFERENT models stores (D-039)`,
      );
    }
    io.stdout(`render pipeline ${diag.version}`);
    io.stdout(`backend env: SPRITEBOOK_GPU_BACKEND=${diag.backendEnv}`);
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
