// Shell bridge: one interface, three backends (Tauri v2, denoshell/webview, plain
// browser). The app is identical in every shell — the D-005 comparison is about
// what each shell makes easy or hard behind this interface.

export interface JobResult {
  exitCode: number | null;
}

export interface ShellBridge {
  name: 'tauri' | 'denoshell' | 'browser';
  /** Spawn the mock core CLI; onLine gets each NDJSON line verbatim. Resolves at exit. */
  spawnJob(frames: number, onLine: (line: string) => void): Promise<JobResult>;
  /** Persist self-test evidence where the harness can read it. */
  saveSelfTest(json: string): Promise<void>;
  /** Native (OS-level) file drop with real paths, if the shell provides it. */
  onNativeFileDrop?(cb: (paths: string[]) => void): void;
}

// ---- Tauri v2 (withGlobalTauri) ------------------------------------------
type TauriGlobal = {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: {
    listen: (
      name: string,
      cb: (e: { payload: unknown }) => void,
    ) => Promise<() => void>;
  };
};

function tauriBridge(t: TauriGlobal): ShellBridge {
  return {
    name: 'tauri',
    async spawnJob(frames, onLine) {
      const unlisten = await t.event.listen('job-line', (e) => onLine(String(e.payload)));
      try {
        const code = await t.core.invoke('spawn_mock_job', { frames });
        return { exitCode: code as number | null };
      } finally {
        unlisten();
      }
    },
    async saveSelfTest(json) {
      await t.core.invoke('save_selftest', { json });
    },
    onNativeFileDrop(cb) {
      // v2 emits webview drag/drop as tauri://drag-drop with { paths, position }
      t.event.listen('tauri://drag-drop', (e) => {
        const payload = e.payload as { paths?: string[] };
        if (payload?.paths?.length) cb(payload.paths);
      });
    },
  };
}

// ---- deno desktop (Deno 2.9+: win.bind() functions appear under `bindings`) --
type DenoshellBindings = {
  denoshellSpawn: (frames: number) => Promise<number | null>;
  denoshellSave: (json: string) => Promise<unknown>;
};

function denoshellBridge(b: DenoshellBindings): ShellBridge {
  return {
    name: 'denoshell',
    async spawnJob(frames, onLine) {
      // Deno-side pushes lines via win.executeJs -> window.__denoshell_online(line)
      (window as unknown as Record<string, unknown>).__denoshell_online = onLine;
      const code = await b.denoshellSpawn(frames);
      return { exitCode: code };
    },
    async saveSelfTest(json) {
      await b.denoshellSave(json);
    },
    // no native file-drop-with-paths API in deno desktop — HTML5 drag-drop only
    // (documented gap; recorded as D-005 evidence)
  };
}

// ---- plain browser (Claude/desktop browser verification) -------------------
function browserBridge(): ShellBridge {
  return {
    name: 'browser',
    async spawnJob(frames, onLine) {
      // simulate the mock CLI so the UI is fully exercisable without a shell
      const jobId = crypto.randomUUID();
      const emit = (event: string, data: Record<string, unknown> = {}) =>
        onLine(JSON.stringify({ event, jobId, ts: new Date().toISOString(), ...data }));
      emit('queued');
      emit('started', { verb: 'bake', frames });
      for (let f = 1; f <= frames; f++) {
        emit('progress', { frame: f, pct: Math.round((f / frames) * 100) });
        await new Promise((r) => setTimeout(r, 10));
      }
      emit('artifact', { path: 'mock://atlas-page-0.png', kind: 'atlas' });
      emit('done', { ok: true, frames });
      return { exitCode: 0 };
    },
    async saveSelfTest(json) {
      console.log('[selftest]', json);
    },
  };
}

export function detectBridge(): ShellBridge {
  const w = window as unknown as Record<string, unknown>;
  if (w.__TAURI__) return tauriBridge(w.__TAURI__ as TauriGlobal);
  const b = w.bindings as DenoshellBindings | undefined;
  if (b?.denoshellSpawn) return denoshellBridge(b);
  return browserBridge();
}
