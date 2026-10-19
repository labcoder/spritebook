import { promises as fs } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
/**
 * A machine-wide VRAM lease, coordinated through the filesystem (P4-T3).
 *
 * ## Why this exists as well as the queue's budget
 *
 * `JobQueue`'s budget admits jobs inside ONE process. That is the wrong
 * boundary for the thing it is protecting: the Studio spawns every job as its
 * own `spritebook` subprocess (`run_cli` in the Tauri shell), and a user with
 * two characters generating has two Node processes, each with its own queue,
 * each certain it has the whole card. The GPU is a machine resource, so the
 * budget has to live where every process can see it — a directory.
 *
 * ## The protocol
 *
 * One directory, one JSON file per participant. A file is a claim:
 *
 *   { state: 'waiting' | 'held', gb, at, pid, jobId }
 *
 * A process writes its file as `waiting` the moment it arrives, then polls.
 * Under a directory mutex it may flip itself to `held` when — and only when —
 * it is the OLDEST live waiter and its GiB fit in what the held claims leave.
 * That gives the same property the in-process queue has and for the same
 * reason: a 16 GiB job cannot be starved by a stream of 1 GiB ones, and "why
 * is nothing running" has one answer instead of a race.
 *
 * ## Liveness: a heartbeat, not a signal — and why
 *
 * The task called for PID-liveness reaping. A recorded pid is here and is what
 * the wait message names, but the REAPER is a heartbeat (each participant
 * touches its own file's mtime; a file not touched within `staleMs` is
 * removed by whoever notices). The Node port preserves this protocol: PID-only
 * probes cannot distinguish a recycled pid, and a kernel lock only establishes
 * exclusion rather than the age or health of a VRAM claim.
 *
 * The heartbeat is also strictly stronger where it overlaps: it reclaims from
 * a process that is alive but wedged, and it cannot be fooled by a recycled
 * pid. What it costs is a bounded delay — a killed holder's GiB come back
 * after `staleMs`, not instantly.
 *
 * ## What it does not do
 *
 * It does not measure VRAM; it accounts for declared claims. A process outside
 * SpriteBook using the card is invisible to it, which is why `minVramGb` is a
 * conservative declaration rather than a measurement, and why the job-time
 * `preflightVram` check stays where it is.
 */
import { canonicalJson, type JobEvent } from '@spritebook/schema';

export interface VramLeaseOptions {
  /** GiB this job holds for its whole run. 0 or less means no claim. */
  gb: number;
  /** for the wait message, so a human can tell which job is holding things up */
  jobId: string;
  /**
   * Total GiB the machine may commit. `null` (detection failed) or undefined
   * means NO budgeting: the lease becomes a no-op rather than inventing a
   * ceiling that would refuse work the card can actually do.
   */
  budgetGb?: number | null;
  /** shared lease directory; defaults to `<tmp>/spritebook-vram` */
  dir?: string;
  /** cancel while waiting */
  signal?: AbortSignal;
  /** called ONCE, the first time this call has to wait, with the reason */
  onWait?: (reason: string) => void;
  /** called once when a wait ends, with how long it lasted in seconds */
  onAcquired?: (waitedS: number) => void;
  pollMs?: number;
  heartbeatMs?: number;
  /** a claim untouched for this long is dead and is reaped */
  staleMs?: number;
  /** give up waiting after this long; omitted = wait forever */
  timeoutMs?: number;
  /** injectable ms clock, for tests */
  now?: () => number;
}

export interface VramLease {
  readonly gb: number;
  /** the claim file, or null when budgeting was off and nothing was written */
  readonly path: string | null;
  release(): Promise<void>;
}

interface Claim {
  state: 'waiting' | 'held';
  gb: number;
  at: number;
  pid: number;
  jobId: string;
}

const LOCK = '.lock';
/** a mutex older than this is from a process that died mid-critical-section */
const LOCK_STALE_MS = 5_000;

export function defaultLeaseDir(): string {
  const tmp = process.env['TMPDIR'] ?? process.env['TEMP'] ?? process.env['TMP'] ?? '/tmp';
  return `${tmp.replace(/[\\/]+$/, '')}/spritebook-vram`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Round to one decimal — nvidia-smi's precision, and float-drift's cure. */
const g1 = (n: number) => Math.round(n * 10) / 10;

async function readClaims(
  dir: string,
  staleMs: number,
  now: number,
): Promise<Map<string, Claim>> {
  const out = new Map<string, Claim>();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out; // swept away underneath us; see withLock's note
  }
  for await (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = `${dir}/${entry.name}`;
    let stat: Stats;
    try {
      stat = await fs.stat(path);
    } catch {
      continue; // reaped by someone else between readDir and here
    }
    // the heartbeat IS the liveness signal; see the module note
    if (now - (stat.mtime?.getTime() ?? 0) > staleMs) {
      await fs.rm(path).catch(() => {});
      continue;
    }
    try {
      const claim = JSON.parse(await fs.readFile(path, 'utf8')) as Claim;
      if (claim && (claim.state === 'waiting' || claim.state === 'held')) {
        out.set(entry.name, claim);
      }
    } catch {
      // a torn or foreign file is not a claim on the budget, but it is also
      // not ours to delete — a half-written claim gets reaped by its own
      // missing heartbeat a moment later
    }
  }
  return out;
}

/** The directory mutex: mkdir is atomic everywhere, including Windows. */
async function withLock<T>(dir: string, now: () => number, fn: () => Promise<T>): Promise<T> {
  const lock = `${dir}/${LOCK}`;
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (err) {
      // The lease directory lives in machine temp, which OS cleaners do sweep.
      // A waiter that crashed the moment its directory vanished would take the
      // job down for a housekeeping task, so it is rebuilt instead. The cost is
      // stated rather than hidden: any live claims that were swept are gone
      // with it, and the machine's accounting restarts from empty.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        await fs.mkdir(dir, { recursive: true });
        continue;
      }
      if (!((err as NodeJS.ErrnoException)?.code === 'EEXIST')) throw err;
      const stat = await fs.stat(lock).catch(() => null);
      // held for longer than any critical section here can take: the holder
      // died between mkdir and remove, and without this everyone stalls
      if (stat && now() - (stat.mtime?.getTime() ?? 0) > LOCK_STALE_MS) {
        await fs.rm(lock, { recursive: true }).catch(() => {});
        continue;
      }
      await sleep(15 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true }).catch(() => {});
  }
}

const NOOP: VramLease = { gb: 0, path: null, release: () => Promise.resolve() };

/**
 * Wait until this job's VRAM fits the machine budget, then hold it.
 *
 * Resolves to a lease whose `release()` must be called on EVERY exit path —
 * a claim that outlives its job shrinks the machine's budget until its
 * heartbeat lapses, and one that is never released at all would shrink it
 * for `staleMs` after every single job.
 */
export async function acquireVramLease(opts: VramLeaseOptions): Promise<VramLease> {
  const gb = g1(Math.max(0, opts.gb));
  const budget = opts.budgetGb == null || opts.budgetGb <= 0 ? null : g1(opts.budgetGb);
  // nothing to coordinate: no claim, no file, no directory
  if (budget === null || gb === 0) return NOOP;
  if (gb > budget) {
    throw new Error(
      `This job needs ${gb} GiB of VRAM and the machine reports ${budget} GiB in total, so it ` +
        `could never start. Use a smaller model, or run it where there is more VRAM.`,
    );
  }

  const now = opts.now ?? (() => Date.now());
  const dir = opts.dir ?? defaultLeaseDir();
  const staleMs = opts.staleMs ?? 10_000;
  const heartbeatMs = opts.heartbeatMs ?? Math.max(500, Math.floor(staleMs / 4));
  const pollMs = opts.pollMs ?? 400;
  await fs.mkdir(dir, { recursive: true });

  const name = `${now()}-${process.pid}-${crypto.randomUUID()}.json`;
  const path = `${dir}/${name}`;
  const claim: Claim = { state: 'waiting', gb, at: now(), pid: process.pid, jobId: opts.jobId };
  await fs.writeFile(path, canonicalJson(claim), { flag: 'wx' });

  // The heartbeat says "still here" for the whole life of the claim, waiting
  // AND held. Unref'd so a lease can never keep the process alive on its own.
  const beat = setInterval(() => {
    const t = new Date(now());
    fs.utimes(path, t, t).catch(() => {});
  }, heartbeatMs);
  beat.unref();

  const started = now();
  let told = false;
  const done = (): VramLease => ({
    gb,
    path,
    release: async () => {
      clearInterval(beat);
      await fs.rm(path).catch(() => {});
    },
  });
  const abandon = async (message: string): Promise<never> => {
    clearInterval(beat);
    await fs.rm(path).catch(() => {});
    throw new Error(message);
  };

  for (;;) {
    if (opts.signal?.aborted) await abandon('Cancelled while waiting for VRAM');
    let reason: string | null = null;
    const granted = await withLock(dir, now, async () => {
      const claims = await readClaims(dir, staleMs, now());
      const mine = claims.get(name);
      if (mine === undefined) {
        // our own claim was reaped: this process was stalled longer than
        // staleMs, so the machine had every right to take it back
        return 'reaped' as const;
      }
      const held = [...claims.values()].filter((c) => c.state === 'held');
      const committed = g1(held.reduce((n, c) => n + c.gb, 0));
      const free = g1(budget - committed);
      // FIFO across processes: the oldest waiter, and only the oldest waiter,
      // may take what fits. Ties break on the filename, which carries the pid
      // and a uuid, so the order is total and every process agrees on it.
      const waiting = [...claims.entries()]
        .filter(([, c]) => c.state === 'waiting')
        .sort(([a, ca], [b, cb]) => ca.at - cb.at || (a < b ? -1 : a > b ? 1 : 0));
      const head = waiting[0];
      if (head !== undefined && head[0] === name && gb <= free) {
        await fs.writeFile(path, canonicalJson({ ...mine, state: 'held' }));
        return 'granted' as const;
      }
      // Name WHO, not just how many. "1 other job(s) holding 20 GiB" tells a
      // user staring at a stuck job nothing they can act on; a jobId and a pid
      // let them find it, watch it, or kill it.
      const who = held
        .map((c) => `${c.jobId} (pid ${c.pid}, ${c.gb} GiB)`)
        .join(', ');
      const ahead = head !== undefined && head[0] !== name ? head[1] : null;
      reason = ahead
        ? `${ahead.jobId} (pid ${ahead.pid}) is ahead in the queue and needs ${ahead.gb} GiB; ` +
          `${free} GiB of the machine's ${budget} GiB is free` +
          (who ? `, held by ${who}` : '')
        : `this job needs ${gb} GiB and ${free} GiB of the machine's ${budget} GiB is free` +
          (who ? `, held by ${who}` : '');
      return 'waiting' as const;
    });

    if (granted === 'granted') {
      if (told) opts.onAcquired?.((now() - started) / 1000);
      return done();
    }
    if (granted === 'reaped') {
      await abandon(
        `This job's VRAM claim was reaped after ${staleMs} ms without a heartbeat, which means ` +
          `the process was stalled long enough for the machine to reclaim its budget.`,
      );
    }
    if (!told && reason !== null) {
      told = true;
      opts.onWait?.(reason);
    }
    if (opts.timeoutMs !== undefined && now() - started > opts.timeoutMs) {
      await abandon(`Waited ${Math.round((now() - started) / 1000)}s for VRAM: ${reason}`);
    }
    await sleep(pollMs);
  }
}

/**
 * `acquireVramLease` for a job that speaks in events.
 *
 * A wait that is invisible is indistinguishable from a hang, and the whole
 * point of leasing is that a job sometimes deliberately does not start. So the
 * notice goes out on the JOB'S OWN stream — the same NDJSON the log drawer
 * replays and `--log-append` sinks — as it happens, not afterwards in a
 * summary nobody reads.
 *
 * Used as `const lease = yield* acquireVramLeaseEvents(...)` from inside a job
 * generator: the events interleave into the job's stream and the lease comes
 * back as the generator's return value.
 */
export async function* acquireVramLeaseEvents(
  opts: VramLeaseOptions,
  at: () => string,
): AsyncGenerator<JobEvent, VramLease, unknown> {
  const jobId = opts.jobId as JobEvent['jobId'];
  const notices: string[] = [];
  let lease: VramLease | undefined;
  let failure: unknown;
  let settled = false;
  // both handlers attached, so `pending` itself never rejects and the race
  // below cannot produce an unhandled rejection while we are yielding
  const pending = acquireVramLease({
    ...opts,
    onWait: (reason) =>
      notices.push(
        `waiting for VRAM — ${reason}. Nothing is wrong; the machine is busy and admission is ` +
          `in order, so this job will start as soon as its turn can be honoured.`,
      ),
    onAcquired: (waitedS) => notices.push(`VRAM available after ${waitedS.toFixed(1)}s; starting`),
  }).then((l) => {
    lease = l;
  }, (err) => {
    failure = err;
  }).finally(() => {
    settled = true;
  });

  while (!settled) {
    await Promise.race([pending, sleep(100)]);
    while (notices.length > 0) {
      yield { t: 'warn', jobId, at: at(), code: 'vram-wait', message: notices.shift()! };
    }
  }
  while (notices.length > 0) {
    yield { t: 'warn', jobId, at: at(), code: 'vram-wait', message: notices.shift()! };
  }
  if (failure !== undefined) throw failure;
  return lease!;
}

/** What the machine currently has committed — for `doctor` and for tests. */
export async function vramCommittedGb(dir = defaultLeaseDir(), staleMs = 10_000): Promise<number> {
  const claims = await readClaims(dir, staleMs, Date.now()).catch(() => new Map<string, Claim>());
  return g1(
    [...claims.values()].filter((c) => c.state === 'held').reduce((n, c) => n + c.gb, 0),
  );
}
