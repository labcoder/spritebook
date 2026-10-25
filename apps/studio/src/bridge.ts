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
import { DEMO_MESH_B64 } from './demo-mesh';
import TOOL_CATALOG from '../../../packages/registry/catalog/tools.json' with { type: 'json' };
import { listenFileDrop } from './filedrop';

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
  runCli(
    args: string[],
    onLine?: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<CliRun>;
  /** `spritebook doctor [--sidecar] --json` through the shell. */
  runDoctor(
    opts: { sidecar: boolean },
    onLine?: (line: string) => void,
  ): Promise<DoctorRun>;
  /** Every `<root>/<ws>/character.json`, verbatim — manifest-as-interface. */
  listWorkspaces(root: string): Promise<RawWorkspace[]>;
  /** Selected bake's contact gif for a workspace dir, as a data URL, if any. */
  readThumb(dir: string): Promise<string | null>;
  /** A source image as a data URL for preview (extension-allowlisted). */
  readImage(path: string): Promise<string | null>;
  /** The PREVIOUS app run's session log tail, for the drawer's replay. */
  prevSession(maxLines: number): Promise<string[] | null>;
  /** rig/deform-report.json, verbatim, when a rig has been run. */
  readRigReport(dir: string): Promise<unknown | null>;
  /** The selected bake's atlas page + manifest (pages are rect-identical). */
  readBakeAtlas(
    dir: string,
    pass?: string,
    pageIndex?: number,
  ): Promise<{ manifest: unknown; png: string } | null>;
  readLookPreview(dir: string, key: string): Promise<unknown | null>;
  /** Reveal a produced folder in the OS file manager. */
  openFolder(path: string): Promise<void>;
  /** Canonical glTF bytes (base64) for the inspection viewport. */
  readMesh(path: string): Promise<string | null>;
  /** Write a joint-edits patch into the character's rig dir; returns its path. */
  writeRigEdits(dir: string, json: string): Promise<string>;
  /** Native file drop with real paths, when the shell provides it. */
  onFileDrop?(cb: (paths: string[]) => void): () => void;
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

export const PROJECT_URL = 'https://github.com/labcoder/spritebook';

export async function openProjectWebsite(): Promise<void> {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (tauri) await tauri.core.invoke('open_project_website');
  else window.open(PROJECT_URL, '_blank', 'noopener,noreferrer');
}

function tauriBridge(t: TauriGlobal): StudioBridge {
  let seq = 0;
  const runCli = async (
    args: string[],
    onLine?: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<CliRun> => {
    if (signal?.aborted) return { exitCode: 130, lines: [] };
    const jobId = `${args[0] ?? 'cli'}-${Date.now()}-${++seq}`;
    const lines: string[] = [];
    const unlisten = await t.event.listen(`cli:${jobId}`, (e) => {
      const line = String(e.payload);
      lines.push(line);
      log.append(jobId, line);
      onLine?.(line);
    });
    const unlistenStderr = await t.event.listen(`cli-stderr:${jobId}`, (e) => {
      log.append(jobId, String(e.payload), Date.now(), 'stderr');
    }).catch((e) => {
      unlisten();
      throw e;
    });
    let started = false;
    const cancel = () => {
      if (started) {
        void t.core.invoke('cancel_cli', { jobId }).catch((e) => {
          log.append(jobId, `Could not cancel: ${e}`, Date.now(), 'stderr');
        });
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) return { exitCode: 130, lines: [] };
      started = true;
      const exitCode = (await t.core.invoke('run_cli', { jobId, args })) as
        | number
        | null;
      return { exitCode: signal?.aborted ? 130 : exitCode, lines };
    } catch (e) {
      log.append(jobId, String(e), Date.now(), 'stderr');
      return { exitCode: signal?.aborted ? 130 : 1, lines };
    } finally {
      signal?.removeEventListener('abort', cancel);
      unlistenStderr();
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
      const r = (await t.core.invoke('read_image', { path })) as [
        string,
        string,
      ] | null;
      return r ? `data:${r[0]};base64,${r[1]}` : null;
    },
    async prevSession(maxLines) {
      return (await t.core.invoke('read_prev_session', { maxLines })) as
        | string[]
        | null;
    },
    async readRigReport(dir) {
      return await t.core.invoke('read_rig_report', { dir });
    },
    async readBakeAtlas(dir, pass, pageIndex) {
      return (await t.core.invoke('read_bake_atlas', {
        dir,
        pass: pass ?? 'lit',
        pageIndex: pageIndex ?? 0,
      })) as
        | { manifest: unknown; png: string }
        | null;
    },
    async readLookPreview(dir, key) {
      return await t.core.invoke('read_look_preview', { dir, key });
    },
    async openFolder(path) {
      await t.core.invoke('open_folder', { path });
    },
    async readMesh(path) {
      return (await t.core.invoke('read_mesh', { path })) as string | null;
    },
    async writeRigEdits(dir, json) {
      return (await t.core.invoke('write_rig_edits', { dir, json })) as string;
    },
    onFileDrop(cb) {
      // v2 emits webview drag/drop as tauri://drag-drop with { paths, position }
      return listenFileDrop(
        (receive) =>
          t.event.listen('tauri://drag-drop', (e) => {
            const payload = e.payload as { paths?: string[] };
            if (payload?.paths?.length) receive(payload.paths);
          }),
        cb,
        (error) =>
          log.append('file-drop', `Could not register file drop: ${error}`, Date.now(), 'stderr'),
      );
    },
  };
}

/* ---- browser demo: fixed data, honestly labeled ---- */

const DEMO_MANIFEST = {
  id: 'bulma-fixed',
  displayName: 'bulma-fixed',
  look: { stylePresetId: 'pixel', cameraPresetId: 'standard-30' },
  rig: { track: 'B', accepted: false, jointCount: 52 },
  animationSet: [
    {
      clipId: 'idle-loop',
      packId: 'ual',
      enabled: true,
      frames: 6,
      speed: 1,
      holdLast: false,
    },
    {
      clipId: 'walk-loop',
      packId: 'ual',
      enabled: true,
      frames: 8,
      speed: 1.5,
      holdLast: false,
    },
    {
      clipId: 'death',
      packId: 'ual',
      enabled: false,
      frames: 10,
      speed: 1,
      holdLast: true,
    },
  ],
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
            pipelineType: {
              type: 'string',
              enum: ['512', '1024', '1024_cascade'],
            },
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

const DEMO_LOOK_PRESETS = {
  defaults: { camera: 'standard-30', style: 'pixel' },
  cameras: [
    {
      id: 'low-15',
      elevationDeg: 15,
      directions: 8,
      yawOffsetDeg: 0,
      pixelsPerMeter: 32,
      cellPx: { w: 64, h: 64 },
      paddingPx: 6,
    },
    {
      id: 'two-to-one',
      elevationDeg: 26.565,
      directions: 8,
      yawOffsetDeg: 0,
      pixelsPerMeter: 32,
      cellPx: { w: 64, h: 64 },
      paddingPx: 6,
    },
    {
      id: 'standard-30',
      elevationDeg: 30,
      directions: 8,
      yawOffsetDeg: 0,
      pixelsPerMeter: 32,
      cellPx: { w: 64, h: 64 },
      paddingPx: 6,
    },
    {
      id: 'isometric',
      elevationDeg: 35.264,
      directions: 8,
      yawOffsetDeg: 0,
      pixelsPerMeter: 32,
      cellPx: { w: 64, h: 64 },
      paddingPx: 6,
    },
  ],
  styles: [
    {
      id: 'cel-2',
      mode: 'cel',
      maxColors: 6,
      outlineWidthPx: 1,
      superSample: 4,
      alphaMode: '1bit',
    },
    { id: 'clean', mode: 'painterly', superSample: 4, alphaMode: 'soft' },
    {
      id: 'pixel',
      mode: 'pixel',
      maxColors: 16,
      outlineWidthPx: 0.5,
      superSample: 4,
      alphaMode: '1bit',
    },
    {
      id: 'painterly',
      mode: 'painterly',
      maxColors: 32,
      superSample: 4,
      alphaMode: 'soft',
    },
  ],
};

const DEMO_CLIPS = {
  pack: 'ual',
  clips: [
    {
      id: 'idle-loop',
      name: 'Idle_Loop',
      category: 'idle',
      tags: ['idle', 'loop'],
      durationS: 2.0,
      loop: true,
    },
    {
      id: 'walk-loop',
      name: 'Walk_Loop',
      category: 'locomotion',
      tags: ['walk', 'loop'],
      durationS: 1.1,
      loop: true,
    },
    {
      id: 'run-loop',
      name: 'Run_Loop',
      category: 'locomotion',
      tags: ['run', 'loop'],
      durationS: 0.8,
      loop: true,
    },
    {
      id: 'sword-slash',
      name: 'Sword_Slash',
      category: 'combat',
      tags: ['sword', 'attack'],
      durationS: 1.4,
      loop: false,
    },
    {
      id: 'death',
      name: 'Death',
      category: 'combat',
      tags: ['death', 'fall'],
      durationS: 2.2,
      loop: false,
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
      if (args[0] === 'extensions' && args[1] === 'list') {
        return Promise.resolve({
          exitCode: 0,
          lines: [emit(JSON.stringify({
            ...DEMO_CATALOG,
            tools: TOOL_CATALOG.tools.map((tool) => ({
              ...tool,
              download: tool.downloads[0],
              selected: null,
              managed: [],
              detected: [],
              issue: null,
            })),
            content: [
              {
                id: 'ual',
                displayName: 'UAL (browser demo)',
                kind: 'animation-pack',
                clipCount: DEMO_CLIPS.clips.length,
                license: 'CC0-1.0',
                bundled: true,
              },
              ...DEMO_LOOK_PRESETS.styles.map((style) => ({
                id: style.id,
                displayName: style.id,
                kind: 'style',
                bundled: true,
              })),
            ],
          }))],
        });
      }
      if (args[0] === 'models' && args[1] === 'list') {
        return Promise.resolve({
          exitCode: 0,
          lines: [emit(JSON.stringify(DEMO_CATALOG))],
        });
      }
      if (args[0] === 'look' && args.includes('--list')) {
        return Promise.resolve({
          exitCode: 0,
          lines: [emit(JSON.stringify(DEMO_LOOK_PRESETS))],
        });
      }
      if (args[0] === 'anim' && args.includes('--list')) {
        return Promise.resolve({
          exitCode: 0,
          lines: [emit(JSON.stringify(DEMO_CLIPS))],
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
          // canonical mesh, no rig yet: the "run rig" state demos here
          dir: 'demo/clay',
          manifest: {
            id: 'clay',
            displayName: 'clay',
            canonicalMesh: { heightM: 1.7 },
            generation: {
              pickedResultId: 'r1',
              results: [{ id: 'r1', seed: 3 }],
            },
            look: { stylePresetId: 'clean', cameraPresetId: 'standard-30' },
            source: { kind: 'image' },
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
    readRigReport(dir) {
      if (!dir.includes('bulma')) return Promise.resolve(null);
      return Promise.resolve({
        schemaVersion: 1,
        poses: ['bend+30deg', 'bend-30deg'],
        flaggedJoints: ['thumb_03_l', 'pinky_01_l', 'clavicle_r'],
        joints: [
          {
            joint: 'spine_01',
            flags: [],
            maxEdgeStretch: 1.0,
            meanDisplacementM: 0.07,
            spannedComponents: 1,
          },
          {
            joint: 'thumb_03_l',
            flags: ['excessive-stretch'],
            maxEdgeStretch: 3.87,
            meanDisplacementM: 0.004,
            spannedComponents: 1,
          },
          {
            joint: 'pinky_01_l',
            flags: ['no-influence'],
            maxEdgeStretch: 0,
            meanDisplacementM: 0,
            spannedComponents: 1,
          },
          {
            joint: 'clavicle_r',
            flags: ['excessive-stretch'],
            maxEdgeStretch: 12.7,
            meanDisplacementM: 0.012,
            spannedComponents: 2,
          },
        ],
      });
    },
    readLookPreview() {
      return Promise.resolve(null);
    },
    readBakeAtlas(_dir, _pass) {
      // a SYNTHETIC 2-direction x 3-frame atlas (16px cells) so the strips
      // demo honestly in a browser; the desktop shell serves real bake bytes
      return Promise.resolve({
        manifest: {
          bakeId: 'demo0000',
          metrics: {
            cacheHitPct: 0,
            flickerPct: 0.3,
            framesTotal: 6,
            wallTimeS: 3.2,
          },
          flags: [{
            code: 'silhouette-clipped',
            severity: 'warn',
            sourceStage: 'look',
            message:
              'the silhouette reaches the cell edge on 2 frames (bottom). Lower pixelsPerMeter or raise cellPx.',
          }],
          atlases: [{
            pass: 'lit',
            png: 'atlas_lit_0.png',
            pageIndex: 0,
            sizePx: 96,
          }],
          frames: [
            {
              clipId: 'idle',
              direction: 0,
              frame: 0,
              atlas: { x: 0, y: 0, w: 16, h: 16, pageIndex: 0 },
            },
            {
              clipId: 'idle',
              direction: 0,
              frame: 1,
              atlas: { x: 16, y: 0, w: 16, h: 16, pageIndex: 0 },
            },
            {
              clipId: 'idle',
              direction: 0,
              frame: 2,
              atlas: { x: 32, y: 0, w: 16, h: 16, pageIndex: 0 },
            },
            {
              clipId: 'idle',
              direction: 1,
              frame: 0,
              atlas: { x: 0, y: 16, w: 16, h: 16, pageIndex: 0 },
            },
            {
              clipId: 'idle',
              direction: 1,
              frame: 1,
              atlas: { x: 16, y: 16, w: 16, h: 16, pageIndex: 0 },
            },
            {
              clipId: 'idle',
              direction: 1,
              frame: 2,
              atlas: { x: 32, y: 16, w: 16, h: 16, pageIndex: 0 },
            },
          ],
        },
        png:
          'iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAYAAADtwH1UAAAAkUlEQVR42u3YoQ3DUBBEQZeTwoxTk8sJDnYvPweDlhh4Jc+Tlh36Qyxvm6S/Xp/vSvNC5QD73KR54XKAY27SAJQDnHOTBqAcYM1NGoBygMuAAAAAAAAAAICbACRJ0l3/gt7ztRPmhcoB9rlJ88LlAMfcpAEoBzjnJg1AOcCamzQA5QCXAQEAAAAAwHMBJEmP6QfHEh34+3dImgAAAABJRU5ErkJggg==',
      });
    },
    openFolder() {
      return Promise.resolve();
    },
    readMesh(path) {
      // a fixed rigged humanoid so the viewport and bone overlay drive in a
      // browser; anything that is not a canonical/result mesh still says no
      return Promise.resolve(
        /\.(glb|gltf)$/i.test(path) ? DEMO_MESH_B64 : null,
      );
    },
    writeRigEdits() {
      return Promise.reject(new Error('writing edits needs the desktop shell'));
    },
    prevSession() {
      return Promise.resolve([
        JSON.stringify({
          t: 'queued',
          jobId: 'demo-prev',
          at: '2026-07-31T00:00:00.000Z',
        }),
        JSON.stringify({
          t: 'done',
          jobId: 'demo-prev',
          at: '2026-07-31T00:00:01.000Z',
        }),
      ]);
    },
  };
}

export function makeBridge(): StudioBridge {
  const t = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
  return t ? tauriBridge(t) : browserBridge();
}
