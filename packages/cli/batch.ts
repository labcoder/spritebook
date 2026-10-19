import { promises as fs } from 'node:fs';
/**
 * The batch surface (P4-T3): `bake --all`, and the plan it refuses to run
 * without.
 *
 * At one character, "run it and see" is a fine interaction. At a hundred it is
 * an overnight run that either was or wasn't necessary, and afterwards nobody
 * can tell which. So this module's real product is the PLAN — a document that
 * says, per character, whether a bake would do work and which field of the
 * recipe made it so, computed without rendering anything.
 *
 * Three deliberate choices, each with a cost:
 *
 * 1. The plan resolves each character through `bakeSpecFromFlags` — the same
 *    function the single-character bake uses (passed in, so this module has no
 *    circular import back to the verb). A second resolution path would drift,
 *    and a plan that predicted a different recipe than the bake then ran would
 *    be worse than no plan.
 *
 * 2. One character's failure never ends the batch. A roster where character 4
 *    has a broken look must still bake the other 99, and the four must be
 *    named in the summary and set the exit code. The plan states this before
 *    it starts rather than surprising anyone at 3am.
 *
 * 3. Bakes run SERIALLY, and there is no flag to change that. Each bake
 *    saturates one GPU device through @spritebook/render's single adapter;
 *    running two in one process would interleave passes on shared targets, and
 *    a `--concurrency` knob whose only correct value is 1 is a dead
 *    affordance. Sidecar jobs (gen, rig) are separate processes with their own
 *    VRAM story — that is the queue's problem, not this one's.
 */
import type {
  BakePlan,
  BakePlanEntry,
  BatchReport,
  BatchWarning,
  CacheKeyInputs,
  RosterEntry,
  RosterManifest,
  StaleReason,
} from '@spritebook/schema';
import {
  BakeManifestSchema,
  BakePlanSchema,
  BATCH_REPORT_FILE,
  canonicalJson,
  parseWith,
  PLAN_FILE,
  SCHEMA_VERSION,
} from '@spritebook/schema';
import type { CliIo } from './mod.ts';
import { workspacePaths } from '@spritebook/core';
import type { BakeJobSpec } from '@spritebook/pack';
import { buildCacheInputs, diffCacheInputs } from '@spritebook/pack';

/** What the plan needs from the verb that owns the flag surface. */
export interface PlanDeps {
  now: () => string;
  /**
   * The spec this character's bake WOULD run, or the reason it cannot be
   * resolved. This is `resolveBake` — the verb's own resolution, reading the
   * same flags against the same workspace. Returning the reason rather than
   * throwing is what lets one unbakeable character be reported instead of
   * ending the plan for the other ninety-nine.
   */
  resolve(
    workspace: string,
  ): Promise<{ ok: true; spec: BakeJobSpec } | { ok: false; error: string }>;
  /**
   * The render signature, or null when there is no adapter to ask. Null is not
   * an error: a plan is a useful thing to take on a laptop. It does mean the
   * renderer field cannot be compared, and an entry that would otherwise read
   * `fresh` becomes `unknown` — guessing `fresh` there would skip real work
   * after a GPU change, which is the one direction this must never be wrong in.
   */
  renderSig: string | null;
}

/** Cells a bake produces: directions × frames, summed over the enabled clips. */
export function expectedFrames(spec: BakeJobSpec): number {
  const dirs = spec.camera.directions;
  if (spec.clips?.length) return spec.clips.reduce((n, c) => n + dirs * c.frames, 0);
  return dirs * spec.frames;
}

async function recordedInputs(
  workspace: string,
  entry: RosterEntry,
): Promise<CacheKeyInputs | null> {
  if (entry.lastBakeId === undefined) return null;
  const dir = `${workspacePaths(workspace).bakesDir}/bake-${entry.lastBakeId}`;
  try {
    const doc = JSON.parse(await fs.readFile(`${dir}/manifest.json`, 'utf8'));
    return parseWith(BakeManifestSchema, doc, 'BakeManifest').inputs;
  } catch {
    return null; // gone or unreadable — never-baked is the safe reading
  }
}

async function planOne(
  root: string,
  entry: RosterEntry,
  deps: PlanDeps,
): Promise<BakePlanEntry> {
  const base = {
    id: entry.id,
    dir: entry.dir,
    displayName: entry.displayName,
    ...(entry.lastBakeId !== undefined ? { lastBakeId: entry.lastBakeId } : {}),
    ...(entry.lastBakedAt !== undefined ? { lastBakedAt: entry.lastBakedAt } : {}),
  };
  const blocked = (note: string): BakePlanEntry => ({
    ...base,
    state: 'blocked',
    reasons: [],
    frames: 0,
    staleFrames: 0,
    note,
  });

  if (!entry.ready) {
    return blocked(
      'no canonical mesh on disk — generate one and pick it (`spritebook pick`) before baking',
    );
  }
  const workspace = `${root}/${entry.dir}`;
  const built = await deps.resolve(workspace);
  if (!built.ok) return blocked(built.error);
  const spec = built.spec;
  const frames = expectedFrames(spec);
  const previous = await recordedInputs(workspace, entry);

  if (previous === null) {
    return { ...base, state: 'never-baked', reasons: [], frames, staleFrames: frames };
  }
  // With no adapter there is no signature to compare, so the recipe is built
  // against the one the last bake recorded. Every OTHER field is still
  // compared honestly; only the renderer's own identity is unknown.
  const sig = deps.renderSig ?? previous.rendererVersion;
  let next: CacheKeyInputs;
  try {
    next = await buildCacheInputs(spec, sig, spec.provenance);
  } catch (err) {
    return blocked(err instanceof Error ? err.message : String(err));
  }
  const reasons: StaleReason[] = diffCacheInputs(previous, next);
  if (reasons.length > 0) {
    return { ...base, state: 'stale', reasons, frames, staleFrames: frames };
  }
  if (deps.renderSig === null) {
    return {
      ...base,
      state: 'unknown',
      reasons: [],
      frames,
      staleFrames: frames,
      note: 'every recipe field matches, but there is no GPU adapter here so the renderer ' +
        'signature could not be computed. Counted as work: a machine or driver change since ' +
        'the last bake would be invisible from here, and skipping it would serve stale pixels.',
    };
  }
  return { ...base, state: 'fresh', reasons: [], frames, staleFrames: 0 };
}

/** The whole roster's plan: what `bake --all` would do, and why. */
export async function planRoster(
  roster: RosterManifest,
  deps: PlanDeps,
  changedSince?: string,
): Promise<BakePlan> {
  const characters: BakePlanEntry[] = [];
  for (const entry of roster.characters) {
    characters.push(await planOne(roster.root, entry, deps));
  }
  // an unreadable manifest is a blocked character, not a footnote: it counts
  // against the total the user is shown
  for (const bad of roster.unreadable) {
    characters.push({
      id: bad.dir as BakePlanEntry['id'],
      dir: bad.dir,
      displayName: bad.dir,
      state: 'blocked',
      reasons: [],
      frames: 0,
      staleFrames: 0,
      note: `unreadable character.json: ${bad.error}`,
    });
  }
  const count = (s: BakePlanEntry['state']) => characters.filter((c) => c.state === s).length;
  const staleFrames = characters.reduce((n, c) => n + c.staleFrames, 0);
  return parseWith(BakePlanSchema, {
    schemaVersion: SCHEMA_VERSION,
    root: roster.root,
    plannedAt: deps.now(),
    ...(changedSince !== undefined ? { changedSince } : {}),
    characters,
    totals: {
      considered: characters.length,
      // `unknown` is work: it is counted here because the batch will run it
      toBake: count('never-baked') + count('stale') + count('unknown'),
      fresh: count('fresh'),
      blocked: count('blocked'),
      unknown: count('unknown'),
      staleFrames,
      cachedFrames: characters.reduce((n, c) => n + (c.frames - c.staleFrames), 0),
    },
  }, 'BakePlan');
}

/** Characters the batch will actually bake, in roster order. */
export function toBake(plan: BakePlan): BakePlanEntry[] {
  return plan.characters.filter((c) =>
    c.state === 'never-baked' || c.state === 'stale' || c.state === 'unknown'
  );
}

/**
 * A CliIo that passes everything through untouched and keeps the WARNINGS it
 * sees on the way past.
 *
 * A batch runs each character through `runCli`, so the child's warnings go
 * straight to the terminal and nowhere a summary can reach them. Both output
 * forms are recognised because the batch does not control which one it is in:
 * `--json` writes the JobEvent verbatim, and the human branch writes the
 * `warn [code]: message` line that `emit` builds. Both are the CLI's own
 * shapes, not a guess at them.
 */
export function warnTee(inner: CliIo): { io: CliIo; warns: { code: string; message: string }[] } {
  const warns: { code: string; message: string }[] = [];
  const see = (line: string) => {
    if (line.startsWith('{')) {
      try {
        const e = JSON.parse(line) as { t?: string; code?: string; message?: string };
        if (e.t === 'warn' && e.code && e.message) warns.push({ code: e.code, message: e.message });
        return;
      } catch {
        // not an event line; fall through to the human form
      }
    }
    const m = /^warn \[([^\]]+)\]: ([\s\S]*)$/.exec(line);
    if (m) warns.push({ code: m[1]!, message: m[2]! });
  };
  return {
    io: {
      stdout: (s) => {
        see(s);
        inner.stdout(s);
      },
      stderr: (s) => {
        see(s);
        inner.stderr(s);
      },
      ...(inner.now !== undefined ? { now: inner.now } : {}),
    },
    warns,
  };
}

/** Roll per-character warnings into the report's per-code summary. */
export function summariseWarnings(
  seen: { characterId: string; code: string; message: string }[],
): BatchWarning[] {
  const byCode = new Map<string, { characters: Set<string>; example: string }>();
  for (const w of seen) {
    const entry = byCode.get(w.code) ?? { characters: new Set<string>(), example: w.message };
    entry.characters.add(w.characterId);
    byCode.set(w.code, entry);
  }
  return [...byCode]
    .map(([code, e]) => ({
      code,
      characters: e.characters.size,
      example: e.example,
      firstCharacters: [...e.characters].slice(0, 8) as BatchWarning['firstCharacters'],
    }))
    .sort((a, b) => b.characters - a.characters || (a.code < b.code ? -1 : 1));
}

export async function writeReport(report: BatchReport): Promise<string> {
  const path = `${report.root}/${BATCH_REPORT_FILE}`;
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, canonicalJson(report));
  await fs.rename(tmp, path);
  return path;
}

/** The warnings section of the summary a human reads after an unattended run. */
export function formatWarnings(warnings: BatchWarning[], total: number): string[] {
  if (warnings.length === 0) return ['no warnings across the batch'];
  const lines: string[] = [];
  for (const w of warnings) {
    lines.push(`  ${w.code} — ${w.characters}/${total} character(s)`);
    // the message, wrapped: the remedy is the useful half and a 400-char line
    // in a terminal is a line nobody reads
    for (const chunk of w.example.match(/[\s\S]{1,92}(\s|$)/g) ?? [w.example]) {
      lines.push(`      ${chunk.trim()}`);
    }
    lines.push(
      `      first: ${w.firstCharacters.join(', ')}${
        w.characters > w.firstCharacters.length ? ` …and ${w.characters - 8} more` : ''
      }`,
    );
  }
  return lines;
}

export async function writePlan(plan: BakePlan): Promise<string> {
  const path = `${plan.root}/${PLAN_FILE}`;
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, canonicalJson(plan));
  await fs.rename(tmp, path);
  return path;
}

// ---------------------------------------------------------------------------
// The human rendering
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<BakePlanEntry['state'], string> = {
  'never-baked': 'never baked',
  stale: 'STALE',
  fresh: 'fresh',
  blocked: 'BLOCKED',
  unknown: 'unknown',
};

/**
 * The plan as a terminal reads it. Every stale character names its reasons —
 * the point of the whole exercise is that nobody has to guess why 4800 frames
 * are about to re-render, so the reasons are not summarized away.
 */
export function formatPlan(plan: BakePlan): string[] {
  const lines: string[] = [];
  const t = plan.totals;
  lines.push(`plan for ${plan.root}`);
  if (plan.changedSince !== undefined) {
    lines.push(`  (only characters whose manifest changed since ${plan.changedSince})`);
  }
  for (const c of plan.characters) {
    const head = `  ${c.displayName} (${c.id}) — ${STATE_LABEL[c.state]}`;
    if (c.state === 'fresh') {
      lines.push(`${head}, ${c.frames} frames already baked`);
      continue;
    }
    lines.push(`${head}${c.staleFrames > 0 ? `, ${c.staleFrames} frames to render` : ''}`);
    for (const r of c.reasons) lines.push(`      · ${r.field}: ${r.why}`);
    if (c.note !== undefined) lines.push(`      · ${c.note}`);
  }
  lines.push(
    `${t.toBake} to bake · ${t.fresh} fresh · ${t.blocked} blocked` +
      ` · ${t.staleFrames} frames to render, ${t.cachedFrames} already baked`,
  );
  if (t.blocked > 0) {
    lines.push('blocked characters are skipped; the run continues and exits non-zero');
  }
  return lines;
}
