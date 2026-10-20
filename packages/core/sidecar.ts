import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { modelRuntime, readModelRuntime, sidecarEnvironmentDir } from './model-runtime.ts';

/**
 * Sidecar client + supervisor (P3-T2) — the core side of the wire contract
 * frozen in @spritebook/schema sidecar.ts. Everything the sidecar sends is
 * validated at this choke point; everything core sends passed the params gate
 * first. The supervisor owns the process and is built for the sidecar DYING
 * (sidecar-vram skill): a stream that ends without a terminal event, a refused
 * connection, or a dead process all become an `error` event with
 * `retryable: true`, and the next run() respawns.
 *
 * Layering: the pure-HTTP client functions take `{port, token, adapters}` so
 * the protocol is testable against a mock server in Node; `startSidecar` /
 * `SidecarSession` add the real process (uv-run) on top.
 */
import {
  type JobEvent,
  JobEventSchema,
  parseWith,
  SIDECAR_CONTRACT_VERSION,
  SIDECAR_TOKEN_ENV,
  type SidecarAdapter,
  type SidecarHandshake,
  SidecarHandshakeSchema,
  type SidecarJobRequest,
  SidecarListeningSchema,
} from '@spritebook/schema';
import { validateParams, withDefaults } from './params.ts';

export interface SidecarEndpoint {
  port: number;
  token: string;
  adapters: SidecarAdapter[];
}

const iso = () => new Date().toISOString();

function errEvent(
  jobId: JobEvent['jobId'],
  code: string,
  message: string,
  retryable: boolean,
): JobEvent {
  return { t: 'error', jobId, at: iso(), code, message, retryable };
}

function authHeaders(token: string): HeadersInit {
  return { 'Authorization': `Bearer ${token}` };
}

/** Fetch + validate the handshake; refuse a contract mismatch actionably. */
export async function connectSidecar(
  opts: { port: number; token: string },
): Promise<SidecarHandshake> {
  const res = await fetch(`http://127.0.0.1:${opts.port}/handshake`, {
    headers: authHeaders(opts.token),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`sidecar handshake failed: HTTP ${res.status}`);
  }
  const handshake = parseWith(SidecarHandshakeSchema, await res.json(), 'SidecarHandshake');
  if (handshake.contractVersion !== SIDECAR_CONTRACT_VERSION) {
    throw new Error(
      `sidecar speaks contract v${handshake.contractVersion}, core expects v${SIDECAR_CONTRACT_VERSION} - ` +
        'update spritebook and the sidecar together',
    );
  }
  return handshake;
}

/**
 * Run one job. The params gate runs FIRST: an unknown adapter or invalid
 * params yield a terminal error WITHOUT any HTTP — the sidecar never sees an
 * invalid job (roadmap acceptance). Defaults merge under explicit params, so
 * defaults are validated too.
 */
export async function* runSidecarJob(
  endpoint: SidecarEndpoint,
  req: SidecarJobRequest,
): AsyncIterable<JobEvent> {
  const adapter = endpoint.adapters.find((a) => a.id === req.kind);
  if (!adapter) {
    const roster = endpoint.adapters.map((a) => a.id).join(', ') || '(none)';
    yield errEvent(
      req.jobId,
      'unknown-adapter',
      `no adapter "${req.kind}" in the sidecar roster - available: ${roster}`,
      false,
    );
    return;
  }
  const params = withDefaults(adapter.defaults, req.params);
  const check = validateParams(adapter.paramsSchema, params);
  if (!check.ok) {
    yield errEvent(
      req.jobId,
      'invalid-params',
      `params rejected by "${adapter.id}" schema: ${check.errors.join('; ')}`,
      false,
    );
    return;
  }

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${endpoint.port}/jobs`, {
      method: 'POST',
      headers: { ...authHeaders(endpoint.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: req.jobId, kind: req.kind, params }),
    });
  } catch (e) {
    yield errEvent(
      req.jobId,
      'sidecar-died',
      `sidecar unreachable: ${e instanceof Error ? e.message : String(e)}`,
      true,
    );
    return;
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    yield errEvent(req.jobId, 'sidecar-died', `sidecar refused the job: HTTP ${res.status}`, true);
    return;
  }

  let terminal = false;
  let buffer = '';
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch (e) {
        // connection reset mid-stream — the death rule
        yield errEvent(
          req.jobId,
          'sidecar-died',
          `sidecar stream broke mid-job: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
        return;
      }
      if (chunk.done) break;
      buffer += chunk.value;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event: JobEvent;
        try {
          event = parseWith(JobEventSchema, JSON.parse(line), 'sidecar JobEvent');
        } catch (e) {
          yield errEvent(
            req.jobId,
            'sidecar-protocol',
            `sidecar emitted an invalid event line: ${e instanceof Error ? e.message : String(e)}`,
            false,
          );
          return;
        }
        if (event.t === 'done' || event.t === 'error') terminal = true;
        yield event;
        if (terminal) return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!terminal) {
    // stream ended without done|error — the sidecar died under the job
    yield errEvent(
      req.jobId,
      'sidecar-died',
      'sidecar stream ended without a terminal event (process died mid-job?)',
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Process supervision
// ---------------------------------------------------------------------------

export interface SidecarConfig {
  /** the uv project directory (contains pyproject.toml) */
  sidecarDir: string;
  /** explicit port; default 0 = ephemeral, read from the listening line */
  port?: number;
  /** startup deadline; the FIRST run after `uv sync` can be slow */
  startTimeoutMs?: number;
  uvBin?: string;
}

export interface SidecarHandle extends SidecarEndpoint {
  pid: number;
  handshake: SidecarHandshake;
  proc: ChildProcessByStdio<null, Readable, Readable>;
  /** resolves when the process exits (for death detection) */
  exited: Promise<{ code: number; success: boolean; signal: NodeJS.Signals | null }>;
  stderrTail: () => string;
}

function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Read stdout up to the first newline, with a deadline. */
async function readListeningLine(
  stdout: ReadableStream<Uint8Array>,
  timeoutMs: number,
  stderrTail: () => string,
): Promise<{ line: string; rest: ReadableStream<Uint8Array> }> {
  const reader = stdout.getReader();
  let buf = '';
  // cancel() resolves the pending read() as {done:true} — it does NOT reject
  // with the cancel reason — so a flag is the only way the done-branch can
  // tell "timed out" from "process exited" (P3-T2 review P2-1)
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    const decoder = new TextDecoder();
    while (!buf.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(
          timedOut
            ? `sidecar did not announce its port within ${timeoutMs}ms ` +
              `(first run does a uv sync - retry or run 'uv sync' in the sidecar dir). ` +
              `stderr tail:\n${stderrTail()}`
            : `sidecar exited before announcing its port. stderr tail:\n${stderrTail()}`,
        );
      }
      buf += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  return { line: buf.slice(0, buf.indexOf('\n')).trim(), rest: stdout };
}

/** Spawn the sidecar, learn its port, handshake, enforce the contract. */
export async function startSidecar(cfg: SidecarConfig): Promise<SidecarHandle> {
  const token = mintToken();
  const env: NodeJS.ProcessEnv = { ...process.env, [SIDECAR_TOKEN_ENV]: token };
  if (env.SPRITEBOOK_RESOURCES) {
    env.PYTHONDONTWRITEBYTECODE ??= '1';
    env.PYTHONUTF8 ??= '1';
  }
  if (env.SPRITEBOOK_RESOURCES && !env.UV_PROJECT_ENVIRONMENT) {
    env.UV_PROJECT_ENVIRONMENT = await sidecarEnvironmentDir(cfg.sidecarDir);
  }
  const recipes = await readdir(join(cfg.sidecarDir, 'runtimes')).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const name of recipes) {
    if (!name.endsWith('.json')) continue;
    const info = await modelRuntime(name.slice(0, -5), cfg.sidecarDir);
    if (!await readModelRuntime(info)) continue;
    if (info.recipe.project === '.') env.UV_PROJECT_ENVIRONMENT ??= info.environment;
    for (const [key, path] of Object.entries(info.recipe.environment)) {
      env[key] ??= join(info.root, path);
    }
  }
  const proc = spawn(cfg.uvBin ?? env.SPRITEBOOK_UV_BIN ?? 'uv', [
    'run',
    '--frozen',
    // Python 3.11's editable .pth loader corrupts Unicode installation paths on Windows.
    ...(env.SPRITEBOOK_RESOURCES ? ['--no-editable'] : []),
    '--project',
    cfg.sidecarDir,
    'spritebook-sidecar',
    '--port',
    String(cfg.port ?? 0),
  ], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = once(proc, 'close').then(([code, signal]) => ({
    code: code ?? -1,
    signal,
    success: code === 0,
  }));
  void exited.catch(() => {});
  await once(proc, 'spawn');

  // stderr → bounded ring buffer; surfaced in every death/startup error
  const stderrLines: string[] = [];
  const stderrTail = () => stderrLines.join('\n');
  (async () => {
    const reader = (Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array<ArrayBuffer>>)
      .pipeThrough(new TextDecoderStream()).getReader();
    let carry = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        carry += chunk.value;
        let nl: number;
        while ((nl = carry.indexOf('\n')) >= 0) {
          stderrLines.push(carry.slice(0, nl));
          carry = carry.slice(nl + 1);
          if (stderrLines.length > 100) stderrLines.shift();
        }
      }
    } catch {
      // stream torn down with the process — the tail keeps what it has
    }
  })();

  try {
    const { line, rest } = await readListeningLine(
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
      cfg.startTimeoutMs ?? 120_000,
      stderrTail,
    );
    // contract: nothing else ever arrives on stdout — drain defensively
    rest.cancel().catch(() => {});
    const listening = parseWith(SidecarListeningSchema, JSON.parse(line), 'SidecarListening');
    const handshake = await connectSidecar({ port: listening.port, token });
    return {
      port: listening.port,
      token,
      adapters: handshake.adapters,
      pid: listening.pid,
      handshake,
      proc,
      exited,
      stderrTail,
    };
  } catch (e) {
    try {
      proc.kill();
    } catch {
      // already gone
    }
    await exited.catch(() => {});
    throw e;
  }
}

/**
 * Session supervisor: owns at most one live sidecar process. `run()` respawns
 * a dead sidecar before submitting — so a killed-mid-job sidecar surfaces a
 * retryable error to the caller, and the RETRY (queue policy or a plain
 * second run()) recovers. dispose() shuts down gracefully, then kills.
 */
export class SidecarSession {
  #cfg: SidecarConfig;
  #handle: SidecarHandle | null = null;
  // set by the exit watcher, NOT probed via Promise.race — racing an
  // `exited.then(...)` against an already-resolved sentinel always loses by a
  // microtask, which read every dead process as alive (caught by the real
  // kill-mid-job acceptance test; the mock suite could never see it)
  #dead = false;
  // in-flight spawn, memoized: two concurrent run()s must share ONE process,
  // not orphan a second python behind the last-write-wins handle (review P2-4)
  #starting: Promise<SidecarHandle> | null = null;

  constructor(cfg: SidecarConfig) {
    this.#cfg = cfg;
  }

  /** The live handle, spawning or respawning as needed. */
  ensure(): Promise<SidecarHandle> {
    if (this.#handle && !this.#dead) return Promise.resolve(this.#handle);
    if (!this.#starting) {
      this.#handle = null;
      this.#dead = false;
      this.#starting = startSidecar(this.#cfg)
        .then((handle) => {
          this.#handle = handle;
          const markDead = () => {
            if (this.#handle === handle) this.#dead = true;
          };
          handle.exited.then(markDead, markDead);
          return handle;
        })
        .finally(() => {
          this.#starting = null;
        });
    }
    return this.#starting;
  }

  async *run(req: SidecarJobRequest): AsyncIterable<JobEvent> {
    let handle: SidecarHandle;
    try {
      handle = await this.ensure();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // honest retryability (review P2-3): a missing uv binary or a sidecar
      // that exits at boot is a CONFIG error a retry loop can never heal; a
      // startup timeout may just be the first-run uv sync being slow
      const permanent = (e as NodeJS.ErrnoException)?.code === 'ENOENT' ||
        message.includes('exited before announcing its port');
      yield errEvent(req.jobId, 'sidecar-start-failed', message, !permanent);
      return;
    }
    for await (const e of runSidecarJob(handle, req)) {
      // protocol-level death also marks the session dead: `uv run` wraps the
      // python process, so killing python does not promptly resolve the
      // WRAPPER's exit promise — without this, an immediate retry would reuse
      // the corpse (caught by the kill-mid-job acceptance test)
      if (e.t === 'error' && e.code === 'sidecar-died') this.#dead = true;
      yield e;
    }
  }

  async dispose(): Promise<void> {
    const handle = this.#handle;
    this.#handle = null;
    if (!handle) return;
    try {
      await fetch(`http://127.0.0.1:${handle.port}/shutdown`, {
        method: 'POST',
        headers: authHeaders(handle.token),
      }).then((r) => r.body?.cancel());
    } catch {
      // unreachable = already dead
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let graceful: boolean;
    try {
      graceful = await Promise.race([
        handle.exited.then(() => true),
        new Promise<false>((resolve) => deadline = setTimeout(() => resolve(false), 3_000)),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    if (!graceful) {
      // the announced pid is the PYTHON process; proc is the uv wrapper —
      // kill both, or a stubborn python could orphan behind a dead wrapper
      try {
        process.kill(handle.pid);
      } catch {
        // already gone
      }
      try {
        handle.proc.kill();
      } catch {
        // exited between the race and the kill
      }
      await handle.exited.catch(() => {});
    }
  }
}
