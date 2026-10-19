/**
 * The session log: every line the shell relays from a core CLI process,
 * VERBATIM (design-system: the log drawer renders the raw NDJSON stream;
 * nothing fails silently). Severity is derived, never rewritten — a line
 * that parses as a JobEvent contributes its `t`; anything else is info.
 *
 * Dependency-free on purpose: the Deno suite holds the severity contract
 * and the cap without a browser.
 */

export type Severity = 'info' | 'warn' | 'error';

export interface LogLine {
  seq: number;
  jobId: string;
  line: string;
  severity: Severity;
  stream: 'stdout' | 'stderr';
  at: number;
}

export function severityOf(line: string): Severity {
  try {
    const e = JSON.parse(line);
    if (e !== null && typeof e === 'object') {
      if (
        e.t === 'error' || (typeof e.error === 'string' && e.error.length > 0)
      ) return 'error';
      if (e.t === 'warn') return 'warn';
    }
    return 'info';
  } catch {
    return 'info';
  }
}

/** Lines kept in memory; the drawer is a tail, not an archive. */
export const LOG_CAP = 2000;

type Listener = () => void;

export class LogStore {
  #lines: LogLine[] = [];
  #seq = 0;
  #listeners = new Set<Listener>();
  /** errors since the drawer was last opened — the collapsed handle's badge */
  #unseenErrors = 0;
  #snapshot: { lines: readonly LogLine[]; unseenErrors: number } = {
    lines: [],
    unseenErrors: 0,
  };

  append(
    jobId: string,
    line: string,
    now: number = Date.now(),
    stream: 'stdout' | 'stderr' = 'stdout',
  ): LogLine {
    const entry: LogLine = {
      seq: ++this.#seq,
      jobId,
      line,
      severity: stream === 'stderr' ? 'error' : severityOf(line),
      stream,
      at: now,
    };
    this.#lines.push(entry);
    if (this.#lines.length > LOG_CAP) {
      this.#lines.splice(0, this.#lines.length - LOG_CAP);
    }
    if (entry.severity === 'error') this.#unseenErrors++;
    this.#emit();
    return entry;
  }

  markSeen(): void {
    if (this.#unseenErrors === 0) return;
    this.#unseenErrors = 0;
    this.#emit();
  }

  /** Stable between appends — safe for useSyncExternalStore. */
  snapshot(): { lines: readonly LogLine[]; unseenErrors: number } {
    return this.#snapshot;
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(): void {
    this.#snapshot = {
      lines: [...this.#lines],
      unseenErrors: this.#unseenErrors,
    };
    for (const fn of this.#listeners) fn();
  }
}

export const log = new LogStore();
