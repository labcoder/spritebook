/**
 * @spritebook/cli - verb surface. P1-T3 lands the first real verbs: `undo`
 * and `redo` over a manifest + its journal, with `--json` always-NDJSON
 * output (the full verb surface arrives through P2+).
 *
 * On-disk journal layout, next to the manifest:
 *   <manifest>                    canonical JSON document
 *   <manifest>.journal.ndjson     append-only ManifestPatch lines
 *   <manifest>.journal.cursor     how many patches are currently applied
 */
import { canonicalJson, type JobEvent, ManifestPatchSchema, parseWith } from '@spritebook/schema';
import { applyPatchOps, encodeEvent } from '@spritebook/core';

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
  return i >= 0 ? args[i + 1] : undefined;
}

/** Run the CLI. Returns the process exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const now = io.now ?? (() => new Date().toISOString());
  const json = args.includes('--json');
  const verb = args[0];

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

  if (verb !== 'undo' && verb !== 'redo') {
    return fail(
      'cli' as JobEvent['jobId'],
      'unknown-verb',
      `Unknown verb "${verb ?? ''}" - available now: undo, redo (see roadmap for the full surface)`,
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
