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
 * (`cli:<jobId>`), never a global event name. Every relayed line also lands
 * in the session log store VERBATIM — the drawer's "nothing fails silently"
 * depends on the bridge never editorializing.
 */
import { log } from './log';

export interface RawWorkspace {
  dir: string;
  manifest: unknown;
}

export interface DoctorRun {
  exitCode: number | null;
  /** the single --json document line, parsed; null when it never appeared */
  report: Record<string, unknown> | null;
}

export interface CliRun {
  exitCode: number | null;
  /** every stdout line, verbatim and in order */
  lines: string[];
}

export interface StudioBridge {
  name: 'tauri' | 'browser-demo';
  /** Any core verb, streamed line-by-line; every line also lands in the log. */
  runCli(args: string[], onLine?: (line: string) => void): Promise<CliRun>;
  /** `spritebook doctor [--sidecar] --json` through the shell. */
  runDoctor(
    opts: { sidecar: boolean },
    onLine?: (line: string) => void,
  ): Promise<DoctorRun>;
  /** Every `<root>/<ws>/character.json`, verbatim — manifest-as-interface. */
  listWorkspaces(root: string): Promise<RawWorkspace[]>;
  /** Newest bake's contact gif for a workspace dir, as a data URL, if any. */
  readThumb(dir: string): Promise<string | null>;
  /** A source image as a data URL for preview (extension-allowlisted). */
  readImage(path: string): Promise<string | null>;
  /** The PREVIOUS app run's session log tail, for the drawer's replay. */
  prevSession(maxLines: number): Promise<string[] | null>;
  /** Native file drop with real paths, when the shell provides it. */
  onFileDrop?(cb: (paths: string[]) => void): void;
}

type TauriGlobal = {
  core: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  event: {
    listen: (
      name: string,
      cb: (e: { payload: unknown }) => void,
    ) => Promise<() => void>;
  };
};

function tauriBridge(t: TauriGlobal): StudioBridge {
  let seq = 0;
  const runCli = async (
    args: string[],
    onLine?: (line: string) => void,
  ): Promise<CliRun> => {
    const jobId = `${args[0] ?? 'cli'}-${Date.now()}-${++seq}`;
    const lines: string[] = [];
    const unlisten = await t.event.listen(`cli:${jobId}`, (e) => {
      const line = String(e.payload);
      lines.push(line);
      log.append(jobId, line);
      onLine?.(line);
    });
    try {
      const exitCode = (await t.core.invoke('run_cli', { jobId, args })) as
        | number
        | null;
      return { exitCode, lines };
    } finally {
      unlisten();
    }
  };
  return {
    name: 'tauri',
    runCli,
    async runDoctor(opts, onLine) {
      const args = opts.sidecar ? ['doctor', '--sidecar', '--json'] : ['doctor', '--json'];
      const { exitCode, lines } = await runCli(args, onLine);
      let report: DoctorRun['report'] = null;
      const last = lines.at(-1);
      if (last !== undefined) {
        try {
          report = JSON.parse(last);
        } catch {
          report = null;
        }
      }
      return { exitCode, report };
    },
    async listWorkspaces(root) {
      return (await t.core.invoke('list_workspaces', {
        root,
      })) as RawWorkspace[];
    },
    async readThumb(dir) {
      const b64 = (await t.core.invoke('read_thumb', { dir })) as string | null;
      return b64 ? `data:image/gif;base64,${b64}` : null;
    },
    async readImage(path) {
      const r = (await t.core.invoke('read_image', { path })) as [string, string] | null;
      return r ? `data:${r[0]};base64,${r[1]}` : null;
    },
    async prevSession(maxLines) {
      return (await t.core.invoke('read_prev_session', { maxLines })) as string[] | null;
    },
    onFileDrop(cb) {
      // v2 emits webview drag/drop as tauri://drag-drop with { paths, position }
      t.event.listen('tauri://drag-drop', (e) => {
        const payload = e.payload as { paths?: string[] };
        if (payload?.paths?.length) cb(payload.paths);
      });
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

function demoReport(sidecar: boolean): Record<string, unknown> {
  return {
    spritebook: '0.5.0-demo',
    adapter: { description: 'demo adapter (browser preview)' },
    probe: { ok: true },
    ...(sidecar
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
  };
}

const DEMO_CATALOG = {
  models: [
    {
      id: 'fixture-gen',
      kind: 'gen3d',
      displayName: 'Fixture generator (synthetic - no download)',
      license: {
        name: 'MIT (part of SpriteBook)',
        spdx: 'MIT',
        requiresAcceptance: false,
      },
      versions: [{
        version: '1.0.0',
        diskBytes: 0,
        platforms: ['windows-cpu', 'linux-cpu', 'macos-cpu'],
        installed: true,
        paramsSchema: {
          properties: {
            seed: { type: 'integer', minimum: 0 },
            candidates: { type: 'integer', minimum: 1, maximum: 8 },
          },
        },
        defaults: { seed: 0, candidates: 1 },
      }],
    },
    {
      id: 'trellis2-4b',
      kind: 'gen3d',
      displayName: 'TRELLIS.2 4B (image to textured mesh)',
      license: { name: 'MIT', spdx: 'MIT', requiresAcceptance: false },
      versions: [{
        version: 'af44b45f',
        diskBytes: 16385069325,
        platforms: ['windows-cuda', 'linux-cuda'],
        minVramGb: 12,
        installed: true,
        paramsSchema: {
          properties: {
            steps: { type: 'integer', minimum: 1, maximum: 100 },
            guidanceStrength: { type: 'number', minimum: 0 },
            pipelineType: { type: 'string', enum: ['512', '1024', '1024_cascade'] },
            lowVram: { type: 'boolean' },
            candidates: { type: 'integer', minimum: 1, maximum: 8 },
          },
        },
        defaults: { lowVram: true, seed: 0 },
        operationDefaults: {
          gen3d: { steps: 12, guidanceStrength: 7.5, pipelineType: '512' },
        },
      }],
    },
    {
      id: 'demo-gated',
      kind: 'gen3d',
      displayName: 'Demo gated model (license + territory)',
      license: {
        name: 'Custom (acceptance required)',
        spdx: 'LicenseRef-Custom',
        requiresAcceptance: true,
        excludedTerritories: ['EU', 'UK', 'KR'],
      },
      versions: [{
        version: '0.1.0',
        diskBytes: 2147483648,
        platforms: ['windows-cuda'],
        minVramGb: 8,
        installed: false,
        paramsSchema: { properties: { seed: { type: 'integer' } } },
        defaults: { seed: 0 },
      }],
    },
  ],
};

function browserBridge(): StudioBridge {
  let seq = 0;
  return {
    name: 'browser-demo',
    runCli(args, onLine) {
      const jobId = `${args[0] ?? 'cli'}-demo-${++seq}`;
      const emit = (line: string) => {
        log.append(jobId, line);
        onLine?.(line);
        return line;
      };
      if (args[0] === 'models' && args[1] === 'list') {
        return Promise.resolve({
          exitCode: 0,
          lines: [emit(JSON.stringify(DEMO_CATALOG))],
        });
      }
      // every mutation is refused honestly in the browser: no shell, no core
      const refusal = JSON.stringify({
        t: 'error',
        jobId,
        code: 'browser-demo',
        message: `"${args.join(' ')}" needs the desktop shell - the browser preview has no core`,
        retryable: false,
      });
      return Promise.resolve({ exitCode: 1, lines: [emit(refusal)] });
    },
    runDoctor(opts) {
      const report = demoReport(opts.sidecar);
      log.append(`doctor-demo-${++seq}`, JSON.stringify(report));
      return Promise.resolve({ exitCode: 0, report });
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
        {
          // no canonical mesh yet: the card the LOCK states demo against
          dir: 'demo/sprout',
          manifest: {
            id: 'sprout',
            displayName: 'sprout',
            generation: { results: [{ id: 'r1' }, { id: 'r2' }] },
            source: { kind: 'image' },
          },
        },
      ]);
    },
    readThumb() {
      return Promise.resolve(null);
    },
    readImage() {
      // a 2x2 checker: enough for the preview STATE without pretending a file
      return Promise.resolve(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNgYGD4z8DA8J+BgQEADQQDAg6dhSMAAAAASUVORK5CYII=',
      );
    },
    prevSession() {
      return Promise.resolve([
        JSON.stringify({ t: 'queued', jobId: 'demo-prev', at: '2026-07-31T00:00:00.000Z' }),
        JSON.stringify({ t: 'done', jobId: 'demo-prev', at: '2026-07-31T00:00:01.000Z' }),
      ]);
    },
  };
}

export function makeBridge(): StudioBridge {
  const t = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
  return t ? tauriBridge(t) : browserBridge();
}
