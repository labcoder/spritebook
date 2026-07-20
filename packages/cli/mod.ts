/**
 * @spritebook/cli - verb surface. P1-T3 landed `undo`/`redo`; P2-T3 lands
 * `bake` (canonical glb -> bake dir via render->style->pack) and `export`
 * (bake dir -> engine-ready files). `--json` gives always-NDJSON output.
 *
 * On-disk journal layout, next to the manifest:
 *   <manifest>                    canonical JSON document
 *   <manifest>.journal.ndjson     append-only ManifestPatch lines
 *   <manifest>.journal.cursor     how many patches are currently applied
 */
import {
  canonicalJson,
  type ExportTargetId,
  ExportTargetIdSchema,
  type JobEvent,
  ManifestPatchSchema,
  parseWith,
} from '@spritebook/schema';
import type { CameraPreset } from '@spritebook/schema';
import { applyPatchOps, encodeEvent } from '@spritebook/core';
import { PRESETS } from '@spritebook/style';
import { runBakeJob } from '@spritebook/pack';
import { runExportJob } from '@spritebook/export';

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
  if (i < 0) return undefined;
  const value = args[i + 1];
  // a flag at end-of-line or followed by another flag has NO value — treating
  // the next token as one silently misparses (`--model --character hero`) or
  // silently disables features (`--cache` last = no caching)
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function numFlag(args: string[], name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || raw.startsWith('--')) {
    throw new Error(`--${name} must be a number (got "${raw}")`);
  }
  return n;
}

/** Like numFlag but requires a positive integer (frame counts, pixel sizes). */
function intFlag(args: string[], name: string, fallback: number): number {
  const n = numFlag(args, name, fallback);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--${name} must be a positive integer (got ${n})`);
  }
  return n;
}

/** Human-readable rendering of an event stream; returns 1 if an error passed. */
async function pump(
  events: AsyncIterable<JobEvent>,
  emit: (e: JobEvent, human: string) => void,
): Promise<number> {
  let failed = 0;
  for await (const e of events) {
    const human = e.t === 'progress'
      ? `[${e.done}/${e.total}] ${e.step}`
      : e.t === 'artifact'
      ? `${e.kind}: ${e.path}`
      : e.t === 'warn'
      ? `warn [${e.code}]: ${e.message}`
      : e.t === 'error'
      ? `error [${e.code}]: ${e.message}`
      : e.t === 'done'
      ? `done in ${e.wallTimeS.toFixed(2)}s`
      : e.t;
    emit(e, human);
    if (e.t === 'error') failed = 1;
  }
  return failed;
}

const DIR_CHOICES = new Set([2, 4, 8, 16]);

/** `--clips walk-loop:6@1.5!hold,idle-loop:4` -> ClipBindingSpec[]. */
function parseClips(raw: string) {
  const seen = new Set<string>();
  return raw.split(',').map((part) => {
    const m = part.trim().match(/^([a-z0-9][a-z0-9-]*):(\d+)(?:@([\d.]+))?(!hold)?$/);
    if (!m) {
      throw new Error(`bad --clips entry "${part.trim()}" - want clip:frames[@speed][!hold]`);
    }
    const frames = Number(m[2]);
    const speed = m[3] ? Number(m[3]) : 1;
    if (frames < 1) throw new Error(`--clips "${m[1]}": frames must be >= 1`);
    if (!(speed > 0)) throw new Error(`--clips "${m[1]}": speed must be > 0`);
    if (seen.has(m[1])) {
      throw new Error(`--clips lists "${m[1]}" twice - one binding per clip`);
    }
    seen.add(m[1]);
    return { clipId: m[1], frames, speed, holdLast: m[4] !== undefined };
  });
}

/** `--adjust quality=high,steps=20` -> params. Values are JSON-parsed so
 * numbers and booleans arrive typed (the backend's paramsSchema is what
 * finally judges them, core-side, before any process is spawned). */
function parseAdjust(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      throw new Error(`bad --adjust entry "${part.trim()}" - want key=value[,key=value]`);
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === '__proto__' || key === 'constructor') {
      throw new Error(`--adjust key "${key}" is not allowed`);
    }
    try {
      out[key] = JSON.parse(value);
    } catch {
      out[key] = value; // a bare string stays a string
    }
  }
  return out;
}

/** The workspace's source dir (mirrors packages/schema/gen.ts SOURCE_DIR). */
function workspacePathsFor(workspace: string): string {
  return `${workspace}/source`;
}

/** Build the CameraPreset for `spritebook bake` from CLI flags + defaults. */
function cameraFromFlags(args: string[]): CameraPreset {
  const directions = intFlag(args, 'directions', 8);
  if (!DIR_CHOICES.has(directions)) throw new Error('--directions must be 2, 4, 8, or 16');
  const cell = intFlag(args, 'cell', 64);
  const elevation = numFlag(args, 'elevation', 30);
  return {
    id: `cli-e${elevation}x${directions}`,
    elevationDeg: elevation,
    directions: directions as CameraPreset['directions'],
    yawOffsetDeg: 0,
    pixelsPerMeter: intFlag(args, 'ppm', 32),
    cellPx: { w: cell, h: cell },
    paddingPx: intFlag(args, 'padding', 6),
    pivot: 'feet-baseline',
    orthographic: true,
  };
}

/** Run the CLI. Returns the process exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const now = io.now ?? (() => new Date().toISOString());
  const json = args.includes('--json');
  const verb = args[0];

  if (verb === '--version' || verb === '-v') {
    const { SPRITEBOOK_VERSION } = await import('./version.ts');
    io.stdout(`spritebook ${SPRITEBOOK_VERSION}`);
    return 0;
  }
  if (verb === 'doctor') {
    const { runDoctor } = await import('./doctor.ts');
    return await runDoctor(args, io);
  }

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

  if (verb === 'anim') {
    // query/install verbs over animation packs (P3-T1). Like doctor, --json
    // emits ONE JSON document (a query snapshot, not a job stream).
    const { importPack, listClips, loadPack } = await import('@spritebook/anim');
    const jsonOut = (doc: unknown) => io.stdout(JSON.stringify(doc));
    try {
      if (args.includes('--list')) {
        // decodeURIComponent: URL.pathname percent-encodes spaces/non-ASCII in
        // the install path (review F3)
        const packsRoot = flag(args, 'packs') ??
          decodeURIComponent(
            new URL('../anim/packs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
          );
        // every subdir with a pack.json is a pack — imported packs list too
        const packDirs: string[] = [];
        for await (const entry of Deno.readDir(packsRoot)) {
          if (!entry.isDirectory) continue;
          try {
            await Deno.stat(`${packsRoot}/${entry.name}/pack.json`);
            packDirs.push(`${packsRoot}/${entry.name}`);
          } catch {
            // not a pack dir
          }
        }
        if (!packDirs.length) {
          return fail(
            'anim' as JobEvent['jobId'],
            'no-packs',
            `no packs under "${packsRoot}" - import one with --import-pack <dir> --into <root>`,
          );
        }
        packDirs.sort();
        const query = { tag: flag(args, 'tag'), category: flag(args, 'category') };
        const out: { pack: string; clips: unknown[] }[] = [];
        for (const dir of packDirs) {
          const pack = await loadPack(dir);
          const clips = listClips(pack, query);
          out.push({ pack: pack.id, clips });
          if (!json) {
            io.stdout(`${pack.name} (${pack.id}) - ${clips.length}/${pack.clips.length} clips`);
            for (const c of clips) {
              io.stdout(
                `  ${c.id.padEnd(26)} ${c.category.padEnd(11)} ${
                  c.durationS.toFixed(2).padStart(5)
                }s${c.loop ? ' loop' : ''}  [${c.tags.join(', ')}]`,
              );
            }
          }
        }
        if (json) jsonOut(out.length === 1 ? out[0] : { packs: out });
        return 0;
      }
      const importSrc = flag(args, 'import-pack');
      if (importSrc) {
        const into = flag(args, 'into');
        if (!into) {
          return fail(
            'anim' as JobEvent['jobId'],
            'missing-arg',
            '--into <packsRoot> is required with --import-pack',
          );
        }
        const pack = await importPack(importSrc, into);
        if (json) jsonOut({ imported: pack.id, clips: pack.clips.length });
        else io.stdout(`imported pack "${pack.id}" (${pack.clips.length} clips) into ${into}`);
        return 0;
      }
      return fail(
        'anim' as JobEvent['jobId'],
        'missing-arg',
        'anim needs --list [--tag t] [--category c] or --import-pack <dir> --into <packsRoot>',
      );
    } catch (err) {
      return fail(
        'anim' as JobEvent['jobId'],
        'anim-failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'gen' || verb === 'pick') {
    const { runGenJob, runPickJob } = await import('@spritebook/gen');
    const { readWorkspace } = await import('@spritebook/core');
    const workspace = flag(args, 'workspace') ?? flag(args, 'out');
    if (!workspace) {
      return fail(
        verb as JobEvent['jobId'],
        'missing-arg',
        '--workspace <dir> is required (the character directory)',
      );
    }
    const sidecarDir = () => {
      const explicit = flag(args, 'sidecar') ?? Deno.env.get('SPRITEBOOK_SIDECAR_DIR');
      if (explicit) return explicit;
      return decodeURIComponent(
        new URL('../../sidecar', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      );
    };

    try {
      if (verb === 'pick') {
        const resultId = flag(args, 'result');
        if (!resultId) {
          return fail(
            'pick' as JobEvent['jobId'],
            'missing-arg',
            '--result <rN> is required - `spritebook gen` prints the id it created',
          );
        }
        return await pump(
          runPickJob({
            jobId: 'pick',
            workspace,
            resultId,
            reproject: args.includes('--reproject'),
            imagePath: flag(args, 'image'),
          }),
          emit,
        );
      }

      // gen
      const character = flag(args, 'character');
      if (!character) {
        return fail('gen' as JobEvent['jobId'], 'missing-arg', '--character <id> is required');
      }
      let image = flag(args, 'image');
      let params = parseAdjust(flag(args, 'adjust'));
      let modelId = flag(args, 'model') ?? 'fixture-gen';
      let seed = flag(args, 'seed') !== undefined ? intFlag(args, 'seed', 0) : undefined;

      // --more-like rN: reuse that receipt's backend and params, vary the seed.
      // The new seed is max(existing)+1 - deterministic given the manifest, and
      // always different, so "more like this" explores instead of repeating.
      const moreLike = flag(args, 'more-like');
      if (moreLike) {
        const manifest = await readWorkspace(workspace);
        const parent = manifest.generation.results.find((r) => r.id === moreLike);
        if (!parent) {
          const ids = manifest.generation.results.map((r) => r.id).join(', ') || '(none)';
          return fail(
            'gen' as JobEvent['jobId'],
            'unknown-result',
            `No result "${moreLike}" to vary - results: ${ids}`,
          );
        }
        modelId = flag(args, 'model') ?? parent.backend.modelId;
        params = { ...parent.params, ...params };
        delete params.seed;
        seed ??= Math.max(...manifest.generation.results.map((r) => r.seed)) + 1;
        image ??= `${workspacePathsFor(workspace)}/${manifest.source.sha256}${
          manifest.source.originalFilename.slice(
            manifest.source.originalFilename.lastIndexOf('.'),
          )
        }`;
      }
      if (!image) {
        return fail(
          'gen' as JobEvent['jobId'],
          'missing-arg',
          '--image <cutout.png> is required (run `spritebook prep` to make one)',
        );
      }

      return await pump(
        runGenJob({
          jobId: 'gen',
          characterId: character as never,
          workspace,
          imagePath: image,
          modelId,
          version: flag(args, 'model-version'),
          seed: seed ?? 0,
          params,
          declaredHeightM: flag(args, 'height') !== undefined
            ? numFlag(args, 'height', 1.7)
            : undefined,
          sidecarDir: sidecarDir(),
          modelsRoot: flag(args, 'models-dir'),
          catalogPath: flag(args, 'catalog'),
        }),
        emit,
      );
    } catch (err) {
      return fail(
        verb as JobEvent['jobId'],
        'bad-args',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'prep') {
    // image prep (P3-T2): rembg cutout + pose preflight through the sidecar.
    // The weight comes from the registry (never auto-downloaded by the
    // adapter); the sidecar dir defaults to the repo checkout and is
    // overridable for installed layouts.
    const image = flag(args, 'image');
    const out = flag(args, 'out');
    if (!image || !out) {
      return fail(
        'prep' as JobEvent['jobId'],
        'missing-arg',
        '--image <file> and --out <dir> are required',
      );
    }
    const registry = await import('@spritebook/registry');
    const { SidecarSession } = await import('@spritebook/core');
    try {
      const root = flag(args, 'models-dir') ?? registry.defaultModelsRoot();
      const installed = await registry.resolveInstalled(root, 'rembg-u2net');
      if (!installed) {
        return fail(
          'prep' as JobEvent['jobId'],
          'model-missing',
          'rembg-u2net is not installed - run `spritebook models install rembg-u2net` first ' +
            `(models root: ${root})`,
        );
      }
      const modelDir = registry.versionDir(root, 'rembg-u2net', installed.version);
      let sidecarDir = flag(args, 'sidecar') ?? Deno.env.get('SPRITEBOOK_SIDECAR_DIR');
      if (!sidecarDir) {
        const repoSidecar = decodeURIComponent(
          new URL('../../sidecar', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
        );
        try {
          await Deno.stat(`${repoSidecar}/pyproject.toml`);
          sidecarDir = repoSidecar;
        } catch {
          return fail(
            'prep' as JobEvent['jobId'],
            'sidecar-missing',
            'cannot find the sidecar project - pass --sidecar <dir> or set SPRITEBOOK_SIDECAR_DIR',
          );
        }
      }
      await Deno.mkdir(out, { recursive: true });
      const session = new SidecarSession({ sidecarDir });
      try {
        return await pump(
          session.run({
            jobId: 'prep' as JobEvent['jobId'],
            kind: 'rembg',
            params: { imagePath: image, outDir: out, modelDir },
          }),
          emit,
        );
      } finally {
        await session.dispose();
      }
    } catch (err) {
      return fail(
        'prep' as JobEvent['jobId'],
        'prep-failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'models') {
    // registry verbs (P3-T2, D-009): list is a query snapshot; install/verify/
    // rm are job streams with the same event discipline as bake/export.
    const registry = await import('@spritebook/registry');
    const jsonOut = (doc: unknown) => io.stdout(JSON.stringify(doc));
    const sub = args[1];
    try {
      const root = flag(args, 'models-dir') ?? registry.defaultModelsRoot();
      if (sub === 'list') {
        const catalog = await registry.loadCatalog(flag(args, 'catalog'));
        const all = await registry.runListQuery({ catalog, root });
        const rows = args.includes('--installed')
          ? all
            .map((m) => ({ ...m, versions: m.versions.filter((v) => v.installed) }))
            .filter((m) => m.versions.length > 0)
          : all;
        if (json) jsonOut({ models: rows });
        else if (rows.length === 0) {
          io.stdout(args.includes('--installed') ? 'no models installed' : 'catalog is empty');
        } else {
          for (const m of rows) {
            const terr = m.license.excludedTerritories?.length
              ? ` [license excludes ${m.license.excludedTerritories.join(', ')}]`
              : '';
            io.stdout(
              `${m.id.padEnd(14)} ${m.kind.padEnd(10)} ${m.displayName} - ${
                m.license.spdx ?? m.license.name
              }${terr}`,
            );
            for (const v of m.versions) {
              const size = `${(v.diskBytes / 1e9).toFixed(2).padStart(6)} GB`;
              const vram = v.minVramGb ? `  >=${v.minVramGb} GiB VRAM` : '';
              io.stdout(
                `  ${v.version.padEnd(12)} ${size}  ${v.platforms.join(',')}${vram}${
                  v.installed ? '  [installed]' : ''
                }`,
              );
            }
          }
        }
        return 0;
      }
      if (sub === 'install' || sub === 'verify' || sub === 'rm') {
        const ref = args[2];
        if (!ref || ref.startsWith('--')) {
          return fail(
            'models' as JobEvent['jobId'],
            'missing-arg',
            `models ${sub} <id[@version]> is required - see \`spritebook models list\``,
          );
        }
        const [modelId, version] = ref.split('@', 2);
        if (sub === 'install') {
          return await pump(
            registry.runInstallJob({
              jobId: 'models',
              catalog: await registry.loadCatalog(flag(args, 'catalog')),
              root,
              modelId,
              version,
              acceptLicense: args.includes('--accept-license'),
              territory: flag(args, 'territory'),
            }),
            emit,
          );
        }
        if (sub === 'verify') {
          return await pump(
            registry.runVerifyJob({
              jobId: 'models',
              catalog: await registry.loadCatalog(flag(args, 'catalog')),
              root,
              modelId,
              version,
            }),
            emit,
          );
        }
        return await pump(registry.runRmJob({ jobId: 'models', root, modelId, version }), emit);
      }
      return fail(
        'models' as JobEvent['jobId'],
        'missing-arg',
        'models needs a subcommand: list [--installed] | install <id[@version]> ' +
          '[--accept-license] [--territory CC] | verify <id[@version]> | rm <id[@version]>',
      );
    } catch (err) {
      return fail(
        'models' as JobEvent['jobId'],
        'models-failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'bake') {
    const model = flag(args, 'model');
    const character = flag(args, 'character');
    const out = flag(args, 'out');
    if (!model || !character || !out) {
      return fail(
        'bake' as JobEvent['jobId'],
        'missing-arg',
        '--model <glb>, --character <id>, and --out <dir> are required',
      );
    }
    const styleId = flag(args, 'style') ?? 'pixel-8';
    // Object.hasOwn: `--style __proto__` must be unknown-style, not a
    // prototype-chain hit that dies later as a confusing TypeError (m7)
    const style = Object.hasOwn(PRESETS, styleId) ? PRESETS[styleId] : undefined;
    if (!style) {
      return fail(
        'bake' as JobEvent['jobId'],
        'unknown-style',
        `Unknown style "${styleId}" - available: ${Object.keys(PRESETS).sort().join(', ')}`,
      );
    }
    // a valueless --clips must not silently bake the legacy idle stub, and a
    // --pack without --clips changes nothing - both are user error, say so
    if (args.includes('--clips') && !flag(args, 'clips')) {
      return fail(
        'bake' as JobEvent['jobId'],
        'bad-args',
        '--clips needs a value: clip:frames[@speed][!hold][,...] - see `spritebook anim --list`',
      );
    }
    if (args.includes('--pack') && !flag(args, 'pack')) {
      return fail('bake' as JobEvent['jobId'], 'bad-args', '--pack needs a directory path');
    }
    if (flag(args, 'pack') && !flag(args, 'clips')) {
      return fail(
        'bake' as JobEvent['jobId'],
        'bad-args',
        '--pack only applies with --clips (it picks where clip ids resolve)',
      );
    }
    try {
      return await pump(
        runBakeJob({
          jobId: 'bake',
          characterId: character,
          modelPath: model,
          camera: cameraFromFlags(args),
          style,
          frames: intFlag(args, 'frames', 6),
          outRoot: out,
          cacheDir: flag(args, 'cache'),
          onlyInvalidated: args.includes('--only-invalidated'),
          clips: flag(args, 'clips') ? parseClips(flag(args, 'clips')!) : undefined,
          packDir: flag(args, 'pack'),
        }),
        emit,
      );
    } catch (err) {
      return fail(
        'bake' as JobEvent['jobId'],
        'bad-args',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'export') {
    const bakeDir = flag(args, 'bake');
    const out = flag(args, 'out');
    const targetsRaw = flag(args, 'targets');
    if (!bakeDir || !out || !targetsRaw) {
      return fail(
        'export' as JobEvent['jobId'],
        'missing-arg',
        '--bake <bakeDir>, --out <dir>, and --targets <a,b,...> are required',
      );
    }
    let targets: ExportTargetId[];
    try {
      targets = targetsRaw.split(',').map((t) =>
        parseWith(ExportTargetIdSchema, t.trim(), `target "${t.trim()}"`)
      );
    } catch (err) {
      return fail(
        'export' as JobEvent['jobId'],
        'unknown-target',
        err instanceof Error ? err.message : String(err),
      );
    }
    // the same arg-error-to-event discipline as the bake branch (M4): a bad
    // --fps must become an NDJSON error event, never a raw throw out of runCli
    try {
      return await pump(
        runExportJob({
          jobId: 'export',
          bakeDir,
          outDir: out,
          targets,
          fps: numFlag(args, 'fps', 8),
        }),
        emit,
      );
    } catch (err) {
      return fail(
        'export' as JobEvent['jobId'],
        'bad-args',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb !== 'undo' && verb !== 'redo') {
    return fail(
      'cli' as JobEvent['jobId'],
      'unknown-verb',
      `Unknown verb "${
        verb ?? ''
      }" - available: prep, gen, pick, models, anim, bake, export, doctor, undo, redo (--version)`,
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
