/**
 * Shell bridge: Tauri v2 when present, a demo-data browser fallback otherwise.
 *
 * The browser fallback exists so chrome, tokens, and a11y are verifiable in a
 * plain browser (CI, in-session preview) without a shell — it serves FIXED
 * demo data and says so in the status bar. Every real capability goes through
 * the Tauri commands, which spawn the core CLI: the GUI stays a projection
 * (invariant 1); nothing here mutates anything.
 *
 * D-005 rider honored: CLI streams arrive on a PER-JOB channel
 * (`cli:<jobId>`), never a global event name.
 */

export interface RawWorkspace {
  dir: string;
  manifest: unknown;
}

export interface DoctorRun {
  exitCode: number | null;
  /** the single --json document line, parsed; null when it never appeared */
  report: Record<string, unknown> | null;
}

export interface StudioBridge {
  name: 'tauri' | 'browser-demo';
  /** `spritebook doctor [--sidecar] --json` through the shell. */
  runDoctor(opts: { sidecar: boolean }, onLine?: (line: string) => void): Promise<DoctorRun>;
  /** Every `<root>/<ws>/character.json`, verbatim — manifest-as-interface. */
  listWorkspaces(root: string): Promise<RawWorkspace[]>;
  /** Newest bake's contact gif for a workspace dir, as a data URL, if any. */
  readThumb(dir: string): Promise<string | null>;
}

type TauriGlobal = {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: {
    listen: (name: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
  };
};

function tauriBridge(t: TauriGlobal): StudioBridge {
  let seq = 0;
  return {
    name: 'tauri',
    async runDoctor(opts, onLine) {
      const jobId = `doctor-${Date.now()}-${++seq}`;
      let last: string | null = null;
      const unlisten = await t.event.listen(`cli:${jobId}`, (e) => {
        const line = String(e.payload);
        last = line;
        onLine?.(line);
      });
      try {
        const args = opts.sidecar ? ['doctor', '--sidecar', '--json'] : ['doctor', '--json'];
        const exitCode = (await t.core.invoke('run_cli', { jobId, args })) as number | null;
        let report: DoctorRun['report'] = null;
        if (last !== null) {
          try {
            report = JSON.parse(last);
          } catch {
            report = null;
          }
        }
        return { exitCode, report };
      } finally {
        unlisten();
      }
    },
    async listWorkspaces(root) {
      return (await t.core.invoke('list_workspaces', { root })) as RawWorkspace[];
    },
    async readThumb(dir) {
      const b64 = (await t.core.invoke('read_thumb', { dir })) as string | null;
      return b64 ? `data:image/gif;base64,${b64}` : null;
    },
  };
}

/* ---- browser demo: fixed data, honestly labeled ---- */

const DEMO_MANIFEST = {
  id: 'bulma-fixed',
  displayName: 'bulma-fixed',
  look: { stylePresetId: 'pixel', cameraPresetId: 'standard-30' },
  rig: { track: 'B', accepted: false, jointCount: 52 },
  generation: { pickedResultId: 'r2' },
  lastBakeId: '704614bc',
  canonicalMesh: { heightM: 1.65, reprojected: true, colorMatched: true },
  source: { kind: 'image' },
};

function browserBridge(): StudioBridge {
  return {
    name: 'browser-demo',
    runDoctor(opts) {
      return Promise.resolve({
        exitCode: 0,
        report: {
          spritebook: '0.5.0-demo',
          adapter: { description: 'demo adapter (browser preview)' },
          probe: { ok: true },
          ...(opts.sidecar
            ? {
              sidecar: {
                ok: true,
                contractVersion: 1,
                sidecarVersion: 'demo',
                python: '3.x-demo',
                adapters: [{ id: 'fixture-gen', kind: 'gen3d', version: '0' }],
              },
            }
            : {}),
        },
      });
    },
    listWorkspaces() {
      return Promise.resolve([
        { dir: 'demo/bulma-fixed', manifest: DEMO_MANIFEST },
        {
          dir: 'demo/mermaid',
          manifest: {
            ...DEMO_MANIFEST,
            id: 'mermaid',
            displayName: 'mermaid',
            look: { stylePresetId: 'clean', cameraPresetId: 'standard-30' },
            rig: { track: 'B', accepted: true, jointCount: 52 },
            generation: { pickedResultId: 'r1' },
            lastBakeId: undefined,
          },
        },
      ]);
    },
    readThumb() {
      return Promise.resolve(null);
    },
  };
}

export function makeBridge(): StudioBridge {
  const t = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
  return t ? tauriBridge(t) : browserBridge();
}
