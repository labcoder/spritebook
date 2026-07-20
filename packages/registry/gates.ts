/**
 * Install gates (D-009), pure functions so the CLI/event layer stays thin.
 * Every failure message is a complete sentence a stranger can act on. The
 * license and territory gates enforce the catalog's terms honestly — the
 * restriction is the licensor's, not ours to bend (D-027: territory is a
 * recorded self-declaration, never geolocation). The VRAM gate NEVER blocks:
 * install-time is advisory, the job-time preflight is the hard gate
 * (sidecar-vram skill).
 */
import type { ModelEntry, ModelVersion, Platform } from '@spritebook/schema';

export type GateResult = { ok: true } | { ok: false; code: string; message: string };

const OK: GateResult = { ok: true };

/** Licenses that require acceptance need the user's explicit --accept-license. */
export function gateLicense(
  entry: ModelEntry,
  opts: { acceptLicense: boolean },
): GateResult {
  if (!entry.license.requiresAcceptance || opts.acceptLicense) return OK;
  const lic = entry.license;
  const name = lic.spdx ? `${lic.name} (${lic.spdx})` : lic.name;
  const read = lic.url ? ` Read it at ${lic.url}.` : '';
  return {
    ok: false,
    code: 'license-acceptance-required',
    message: `Model "${entry.id}" is licensed under ${name}, which requires explicit ` +
      `acceptance.${read} Re-run with --accept-license to record your acceptance ` +
      `in the install receipt.`,
  };
}

/**
 * D-027: when a license excludes territories, the user must self-declare
 * theirs (--territory <ISO>); a declaration on the excluded list is refused.
 * A malformed declaration is rejected up front, exclusions or not — garbage
 * must never land in a receipt.
 */
export function gateTerritory(
  entry: ModelEntry,
  opts: { territory?: string },
): GateResult {
  if (opts.territory !== undefined && !/^[A-Z]{2}$/.test(opts.territory)) {
    return {
      ok: false,
      code: 'territory-invalid',
      message: `Territory "${opts.territory}" is not a two-letter ISO 3166-1 alpha-2 ` +
        `code (like US or DE).`,
    };
  }
  const excluded = entry.license.excludedTerritories;
  if (!excluded || excluded.length === 0) return OK;
  if (opts.territory === undefined) {
    return {
      ok: false,
      code: 'territory-declaration-required',
      message: `The ${entry.license.name} license for model "${entry.id}" excludes these ` +
        `territories: ${excluded.join(', ')}. Declare yours with --territory <ISO code> — ` +
        `a recorded self-declaration; SpriteBook never geolocates you.`,
    };
  }
  if (excluded.includes(opts.territory)) {
    return {
      ok: false,
      code: 'territory-excluded',
      message: `The ${entry.license.name} license for model "${entry.id}" excludes use in ` +
        `${excluded.join(', ')}, and your declared territory ${opts.territory} is on that ` +
        `list, so this model cannot be installed here. The restriction is the license's — ` +
        `only the licensor can lift it.`,
    };
  }
  return OK;
}

/**
 * A version is installable when it lists the detected platform exactly, or
 * lists `<os>-cpu` for the detected OS — a CPU entry runs anywhere with that
 * OS. A cuda/metal entry on a machine without the accelerator is refused
 * with both sides named (D-009; the P0-T4 platform verdict).
 */
export function gatePlatform(version: ModelVersion, detected: Platform): GateResult {
  const os = detected.split('-')[0];
  const cpuFallback = `${os}-cpu` as Platform;
  if (version.platforms.includes(detected) || version.platforms.includes(cpuFallback)) return OK;
  return {
    ok: false,
    code: 'platform-unsupported',
    message: `This model needs ${version.platforms.join(' or ')}; this machine is ${detected}.`,
  };
}

/** VRAM verdicts mirror InstallReceipt.vram.status — advisory only, never a block. */
export type VramGateResult =
  | { status: 'ok' | 'not-required' }
  | { status: 'unknown' | 'below-min'; warn: string };

/**
 * Compare the catalog's MEASURED floor (never README claims — sidecar-vram)
 * against detected VRAM. Warns, never blocks: the job-time preflight is the
 * hard gate, and a smaller GPU may still be fine for smaller meshes.
 */
export function gateVram(version: ModelVersion, detectedGb: number | null): VramGateResult {
  const min = version.minVramGb;
  if (min === undefined) return { status: 'not-required' };
  if (detectedGb === null) {
    return {
      status: 'unknown',
      warn: `This version's measured minimum is ${min} GiB of VRAM, but no NVIDIA GPU was ` +
        `detected to measure against. Installing anyway — the job-time preflight is the ` +
        `hard gate.`,
    };
  }
  if (detectedGb < min) {
    return {
      status: 'below-min',
      warn: `This version's measured minimum is ${min} GiB of VRAM; this machine reports ` +
        `${detectedGb} GiB. Installing anyway — jobs may fail the VRAM preflight or OOM.`,
    };
  }
  return { status: 'ok' };
}

/** Injectable process runner so tests never spawn nvidia-smi. */
export type CommandRunner = (cmd: string[]) => Promise<{ ok: boolean; stdout: string }>;

/** Default runner: any spawn failure (missing binary, no permission) is a clean "no". */
export const runCommand: CommandRunner = async (cmd) => {
  try {
    const out = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: 'piped',
      stderr: 'null',
      stdin: 'null',
    }).output();
    return { ok: out.success, stdout: new TextDecoder().decode(out.stdout) };
  } catch {
    return { ok: false, stdout: '' };
  }
};

/**
 * OS from Deno.build + accelerator probe. `nvidia-smi -L` listing at least
 * one GPU means cuda; darwin is assumed Apple Silicon and reports
 * macos-metal without probing (fine for every Mac we target); anything that
 * is neither windows nor darwin rides the linux entries.
 */
export async function detectPlatform(
  run: CommandRunner = runCommand,
  os: typeof Deno.build.os = Deno.build.os,
): Promise<Platform> {
  if (os === 'darwin') return 'macos-metal';
  const family = os === 'windows' ? 'windows' : 'linux';
  const probe = await run(['nvidia-smi', '-L']);
  const hasGpu = probe.ok && probe.stdout.split('\n').some((l) => /^GPU \d+:/.test(l.trim()));
  return `${family}-${hasGpu ? 'cuda' : 'cpu'}` as Platform;
}

/**
 * Total VRAM of the first GPU in GiB (1 decimal), or null when there is no
 * NVIDIA GPU to ask — null means "unknown", and gateVram treats it as a
 * warn, never a block.
 */
export async function detectVramGb(run: CommandRunner = runCommand): Promise<number | null> {
  const probe = await run([
    'nvidia-smi',
    '--query-gpu=memory.total',
    '--format=csv,noheader,nounits',
  ]);
  if (!probe.ok) return null;
  const first = probe.stdout.split('\n')[0]?.trim();
  if (!first) return null;
  const mib = Number(first);
  if (!Number.isFinite(mib) || mib <= 0) return null;
  return Math.round((mib / 1024) * 10) / 10;
}
