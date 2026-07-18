/**
 * @spritebook/cli - verb surface. P1-T3 landed `undo`/`redo`; P2-T3 lands
 * `bake` (canonical glb -> bake dir via render->style->pack) and `export`
 * (bake dir -> engine-ready files). `--json` gives always-NDJSON output.
 *
 * On-disk journal layout, next to the manifest:
 *   <manifest>                    canonical JSON document
 *   <manifest>.journal.ndjson     append-only ManifestPatch lines
 *   <manifest>.journal.cursor     how many patches are currently applied
 */
import {
  canonicalJson,
  type ExportTargetId,
  ExportTargetIdSchema,
  type JobEvent,
  ManifestPatchSchema,
  parseWith,
} from '@spritebook/schema';
import type { CameraPreset } from '@spritebook/schema';
import { applyPatchOps, encodeEvent } from '@spritebook/core';
import { PRESETS } from '@spritebook/style';
import { runBakeJob } from '@spritebook/pack';
import { runExportJob } from '@spritebook/export';

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  now?: () => string;
}

interface JournalFiles {
  manifest: string;
  journal: string;
  cursor: string;
}

function files(manifestPath: string): JournalFiles {
  return {
    manifest: manifestPath,
    journal: `${manifestPath}.journal.ndjson`,
    cursor: `${manifestPath}.journal.cursor`,
  };
}

async function readJournal(f: JournalFiles) {
  const doc = JSON.parse(await Deno.readTextFile(f.manifest)) as Record<string, unknown>;
  const journalText = await Deno.readTextFile(f.journal).catch(() => '');
  const patches = journalText
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l, i) => parseWith(ManifestPatchSchema, JSON.parse(l), `journal line ${i + 1}`));
  const cursorText = await Deno.readTextFile(f.cursor).catch(() => String(patches.length));
  const cursor = Number(cursorText.trim());
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > patches.length) {
    throw new Error(`corrupt cursor file: "${cursorText.trim()}" (journal has ${patches.length})`);
  }
  return { doc, patches, cursor };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  // a flag at end-of-line or followed by another flag has NO value — treating
  // the next token as one silently misparses (`--model --character hero`) or
  // silently disables features (`--cache` last = no caching)
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function numFlag(args: string[], name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || raw.startsWith('--')) {
    throw new Error(`--${name} must be a number (got "${raw}")`);
  }
  return n;
}

/** Like numFlag but requires a positive integer (frame counts, pixel sizes). */
function intFlag(args: string[], name: string, fallback: number): number {
  const n = numFlag(args, name, fallback);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--${name} must be a positive integer (got ${n})`);
  }
  return n;
}

/** Human-readable rendering of an event stream; returns 1 if an error passed. */
async function pump(
  events: AsyncIterable<JobEvent>,
  emit: (e: JobEvent, human: string) => void,
): Promise<number> {
  let failed = 0;
  for await (const e of events) {
    const human = e.t === 'progress'
      ? `[${e.done}/${e.total}] ${e.step}`
      : e.t === 'artifact'
      ? `${e.kind}: ${e.path}`
      : e.t === 'warn'
      ? `warn [${e.code}]: ${e.message}`
      : e.t === 'error'
      ? `error [${e.code}]: ${e.message}`
      : e.t === 'done'
      ? `done in ${e.wallTimeS.toFixed(2)}s`
      : e.t;
    emit(e, human);
    if (e.t === 'error') failed = 1;
  }
  return failed;
}

const DIR_CHOICES = new Set([2, 4, 8, 16]);

/** Build the CameraPreset for `spritebook bake` from CLI flags + defaults. */
function cameraFromFlags(args: string[]): CameraPreset {
  const directions = intFlag(args, 'directions', 8);
  if (!DIR_CHOICES.has(directions)) throw new Error('--directions must be 2, 4, 8, or 16');
  const cell = intFlag(args, 'cell', 64);
  const elevation = numFlag(args, 'elevation', 30);
  return {
    id: `cli-e${elevation}x${directions}`,
    elevationDeg: elevation,
    directions: directions as CameraPreset['directions'],
    yawOffsetDeg: 0,
    pixelsPerMeter: intFlag(args, 'ppm', 32),
    cellPx: { w: cell, h: cell },
    paddingPx: intFlag(args, 'padding', 6),
    pivot: 'feet-baseline',
    orthographic: true,
  };
}

/** Run the CLI. Returns the process exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const now = io.now ?? (() => new Date().toISOString());
  const json = args.includes('--json');
  const verb = args[0];

  if (verb === '--version' || verb === '-v') {
    const { SPRITEBOOK_VERSION } = await import('./version.ts');
    io.stdout(`spritebook ${SPRITEBOOK_VERSION}`);
    return 0;
  }
  if (verb === 'doctor') {
    const { runDoctor } = await import('./doctor.ts');
    return await runDoctor(args, io);
  }

  const emit = (e: JobEvent, human: string) => {
    if (json) io.stdout(encodeEvent(e).trimEnd());
    else io.stdout(human);
  };
  const fail = (jobId: JobEvent['jobId'], code: string, message: string): number => {
    const e: JobEvent = { t: 'error', jobId, at: now(), code, message, retryable: false };
    if (json) io.stdout(encodeEvent(e).trimEnd());
    else io.stderr(`error: ${message}`);
    return 1;
  };

  if (verb === 'bake') {
    const model = flag(args, 'model');
    const character = flag(args, 'character');
    const out = flag(args, 'out');
    if (!model || !character || !out) {
      return fail(
        'bake' as JobEvent['jobId'],
        'missing-arg',
        '--model <glb>, --character <id>, and --out <dir> are required',
      );
    }
    const styleId = flag(args, 'style') ?? 'pixel-8';
    // Object.hasOwn: `--style __proto__` must be unknown-style, not a
    // prototype-chain hit that dies later as a confusing TypeError (m7)
    const style = Object.hasOwn(PRESETS, styleId) ? PRESETS[styleId] : undefined;
    if (!style) {
      return fail(
        'bake' as JobEvent['jobId'],
        'unknown-style',
        `Unknown style "${styleId}" - available: ${Object.keys(PRESETS).sort().join(', ')}`,
      );
    }
    try {
      return await pump(
        runBakeJob({
          jobId: 'bake',
          characterId: character,
          modelPath: model,
          camera: cameraFromFlags(args),
          style,
          frames: intFlag(args, 'frames', 6),
          outRoot: out,
          cacheDir: flag(args, 'cache'),
          onlyInvalidated: args.includes('--only-invalidated'),
        }),
        emit,
      );
    } catch (err) {
      return fail(
        'bake' as JobEvent['jobId'],
        'bad-args',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'export') {
    const bakeDir = flag(args, 'bake');
    const out = flag(args, 'out');
    const targetsRaw = flag(args, 'targets');
    if (!bakeDir || !out || !targetsRaw) {
      return fail(
        'export' as JobEvent['jobId'],
        'missing-arg',
        '--bake <bakeDir>, --out <dir>, and --targets <a,b,...> are required',
      );
    }
    let targets: ExportTargetId[];
    try {
      targets = targetsRaw.split(',').map((t) =>
        parseWith(ExportTargetIdSchema, t.trim(), `target "${t.trim()}"`)
      );
    } catch (err) {
      return fail(
        'export' as JobEvent['jobId'],
        'unknown-target',
        err instanceof Error ? err.message : String(err),
      );
    }
    // the same arg-error-to-event discipline as the bake branch (M4): a bad
    // --fps must become an NDJSON error event, never a raw throw out of runCli
    try {
      return await pump(
        runExportJob({
          jobId: 'export',
          bakeDir,
          outDir: out,
          targets,
          fps: numFlag(args, 'fps', 8),
        }),
        emit,
      );
    } catch (err) {
      return fail(
        'export' as JobEvent['jobId'],
        'bad-args',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb !== 'undo' && verb !== 'redo') {
    return fail(
      'cli' as JobEvent['jobId'],
      'unknown-verb',
      `Unknown verb "${verb ?? ''}" - available: bake, export, doctor, undo, redo (--version)`,
    );
  }

  const manifestPath = flag(args, 'manifest');
  if (!manifestPath) {
    return fail('cli' as JobEvent['jobId'], 'missing-arg', '--manifest <path> is required');
  }

  const jobId = verb as JobEvent['jobId'];
  const f = files(manifestPath);
  emit({ t: 'queued', jobId, at: now() }, `${verb}: ${manifestPath}`);
  emit({ t: 'started', jobId, at: now() }, 'applying journal...');

  let state;
  try {
    state = await readJournal(f);
  } catch (err) {
    return fail(jobId, 'journal-read', err instanceof Error ? err.message : String(err));
  }

  try {
    if (verb === 'undo') {
      if (state.cursor === 0) return fail(jobId, 'nothing-to-undo', 'Nothing to undo');
      const patch = state.patches[state.cursor - 1];
      const next = applyPatchOps(state.doc, patch.inverse);
      await Deno.writeTextFile(f.manifest, canonicalJson(next));
      await Deno.writeTextFile(f.cursor, String(state.cursor - 1));
      emit(
        { t: 'artifact', jobId, at: now(), kind: 'manifest', path: f.manifest },
        `undid: ${patch.label}`,
      );
    } else {
      if (state.cursor >= state.patches.length) {
        return fail(jobId, 'nothing-to-redo', 'Nothing to redo');
      }
      const patch = state.patches[state.cursor];
      const next = applyPatchOps(state.doc, patch.op);
      await Deno.writeTextFile(f.manifest, canonicalJson(next));
      await Deno.writeTextFile(f.cursor, String(state.cursor + 1));
      emit(
        { t: 'artifact', jobId, at: now(), kind: 'manifest', path: f.manifest },
        `redid: ${patch.label}`,
      );
    }
  } catch (err) {
    return fail(jobId, 'patch-apply', err instanceof Error ? err.message : String(err));
  }

  emit({ t: 'done', jobId, at: now(), wallTimeS: 0 }, 'ok');
  return 0;
}

if (import.meta.main) {
  const code = await runCli(Deno.args, {
    stdout: (l) => console.log(l),
    stderr: (l) => console.error(l),
  });
  Deno.exit(code);
}
