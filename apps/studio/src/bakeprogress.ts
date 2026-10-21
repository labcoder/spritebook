/**
 * The Bake stage's arithmetic, react-free so bake_test.ts holds it: reading
 * core's own progress events, an ETA that refuses to lie, and the player's
 * frame selection over a bake manifest.
 */

export interface ProgressState {
  /** core's step name, verbatim ('cells' | 'pack' | 'write' | …) */
  step: string;
  done: number;
  total: number;
  /** 0..1 */
  fraction: number;
}

/** core emits `{t:'progress', step, done, total}`; anything else is not one. */
export function readProgress(line: string): ProgressState | null {
  try {
    const e = JSON.parse(line);
    if (e?.t !== 'progress' || typeof e.step !== 'string') return null;
    const done = typeof e.done === 'number' ? e.done : 0;
    const total = typeof e.total === 'number' && e.total > 0 ? e.total : 1;
    return { step: e.step, done, total, fraction: Math.min(1, Math.max(0, done / total)) };
  } catch {
    return null;
  }
}

/**
 * Seconds remaining, or null when we cannot honestly say.
 *
 * A bake's steps are NOT equal in cost (cells dominates; write is trivial), so
 * extrapolating from step 1 of 4 would promise a number the run cannot keep.
 * The estimate therefore starts only once a step has completed, and is stated
 * as a range in the UI, never a countdown.
 */
export function etaSeconds(elapsedS: number, p: ProgressState | null): number | null {
  if (!p || p.done < 1 || p.fraction <= 0 || p.fraction >= 1) return null;
  if (elapsedS < 1) return null;
  return Math.round(elapsedS / p.fraction - elapsedS);
}

export interface BakeFrame {
  clipId: string;
  direction: number;
  frame: number;
  pivotPx?: { x: number; y: number };
  cacheHit?: boolean;
  atlas: { x: number; y: number; w: number; h: number; pageIndex: number };
}

export interface BakeSummary {
  bakeId: string;
  frames: BakeFrame[];
  clips: string[];
  directions: number[];
  passes: string[];
  cacheHitPct: number;
  flickerPct: number;
  wallTimeS: number;
  flags: { code: string; severity: string; message: string; sourceStage?: string }[];
}

export function summarize(manifest: unknown): BakeSummary | null {
  if (manifest === null || typeof manifest !== 'object') return null;
  const m = manifest as Record<string, unknown>;
  const frames = (Array.isArray(m.frames) ? m.frames : []) as BakeFrame[];
  if (frames.length === 0) return null;
  const metrics = (m.metrics ?? {}) as Record<string, number>;
  return {
    bakeId: String(m.bakeId ?? '?'),
    frames,
    clips: [...new Set(frames.map((f) => f.clipId))].sort(),
    directions: [...new Set(frames.map((f) => f.direction))].sort((a, b) => a - b),
    passes: (Array.isArray(m.atlases) ? m.atlases : [])
      .map((a) => String((a as Record<string, unknown>).pass ?? ''))
      .filter((p) => p.length > 0),
    cacheHitPct: metrics.cacheHitPct ?? 0,
    flickerPct: metrics.flickerPct ?? 0,
    wallTimeS: metrics.wallTimeS ?? 0,
    flags: (Array.isArray(m.flags) ? m.flags : []) as BakeSummary['flags'],
  };
}

/** The frames of one clip+direction, in play order. */
export function playFrames(
  summary: BakeSummary,
  clipId: string,
  direction: number,
): BakeFrame[] {
  return summary.frames
    .filter((f) => f.clipId === clipId && f.direction === direction)
    .sort((a, b) => a.frame - b.frame);
}

/**
 * Which stage a QA flag belongs to — the "Open <stage> at the flag" jump.
 * `sourceStage` is core's own word for it; anything unrecognized stays on
 * Bake rather than guessing a destination that cannot help.
 */
export function flagStage(flag: { sourceStage?: string }): string {
  const s = flag.sourceStage;
  return s === 'look' || s === 'rig' || s === 'anim' || s === 'gen' ? s : 'bake';
}
