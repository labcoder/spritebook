/**
 * `spritebook gen` — one image in, one canonical textured glb out, with a
 * receipt that can reproduce it (P3-T2).
 *
 * The stage order is the contract (packages/schema/gen.ts): resolve the
 * backend from the registry, run the D-009 gates INCLUDING the job-time VRAM
 * preflight that refuses before weights load, hand the sidecar a cut-out image
 * and a seed, take back a raw glb, push it through THE P1 BORDER, and only
 * then write a GenerationResult pinned to the canonical bytes.
 *
 * Two validations of the same params, on purpose: the catalog entry's
 * paramsSchema is checked HERE (before a process is spawned, so `--adjust
 * quality=banana` costs nothing), and the sidecar client checks the adapter's
 * own schema again at the wire. The entry's schema is the D-009 contract the
 * GUI will render forms from; the adapter's is what the code actually runs.
 */
import {
  type CharacterId,
  type GenerationResult,
  type GenJobSpec,
  type JobEvent,
  preflightVram,
  RAW_MODEL,
} from '@spritebook/schema';
import { validateParams } from '@spritebook/core';
import {
  appendGenerationResult,
  createWorkspace,
  nextResultId,
  readWorkspace,
  resultPaths,
  storeSourceImage,
  workspacePaths,
} from '@spritebook/core';
import { SidecarSession } from '@spritebook/core';
import {
  detectVramGb,
  gatePlatform,
  loadCatalog,
  resolveInstalled,
  versionDir,
} from '@spritebook/registry';
import { defaultModelsRoot, detectPlatform } from '@spritebook/registry';
import { importToCanonical } from '@spritebook/importer';
import { NodeIO } from '@gltf-transform/core';
import { decode as decodePng } from 'fast-png';

export interface GenJobOptions extends GenJobSpec {
  /** models root override (tests, and `--models-dir`) */
  modelsRoot?: string;
  /** the uv sidecar project dir */
  sidecarDir: string;
  /** injected catalog (tests); omitted -> the bundled one */
  catalogPath?: string;
  /** injected VRAM reading (tests); omitted -> the real probe */
  detectedVramGb?: number | null;
}

class GenFail extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Triangle count + texture resolution of canonical bytes, for the receipt. */
async function describeMesh(
  bytes: Uint8Array,
): Promise<{ tris: number; textureRes?: number }> {
  const doc = await new NodeIO().readBinary(bytes);
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0);
      tris += Math.floor(count / 3);
    }
  }
  let textureRes: number | undefined;
  for (const tex of doc.getRoot().listTextures()) {
    const img = tex.getImage();
    if (!img) continue;
    try {
      const decoded = decodePng(img);
      textureRes = Math.max(textureRes ?? 0, decoded.width, decoded.height);
    } catch {
      // a non-PNG texture still counts as textured; resolution stays unknown
    }
  }
  return { tris, ...(textureRes !== undefined ? { textureRes } : {}) };
}

/**
 * Run one generation. Event codes: unknown-model, not-installed,
 * platform-unsupported, vram-insufficient, invalid-params, backend-failed
 * (retryable mirrors the sidecar's verdict), no-mesh, border-failed.
 */
export async function* runGenJob(opts: GenJobOptions): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = opts.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  const startedAt = at();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  let session: SidecarSession | undefined;
  try {
    // 1. the backend, from the catalog
    const catalog = await loadCatalog(opts.catalogPath);
    const entry = catalog.models.find((m) => m.id === opts.modelId);
    if (!entry) {
      const ids = catalog.models.filter((m) => m.kind === 'gen3d').map((m) => m.id).join(', ');
      throw new GenFail(
        'unknown-model',
        `No backend "${opts.modelId}" in the catalog - image-to-3D backends available: ${
          ids || '(none)'
        }`,
      );
    }
    if (entry.kind !== 'gen3d') {
      throw new GenFail(
        'unknown-model',
        `Model "${entry.id}" is a ${entry.kind} model, not an image-to-3D backend`,
      );
    }
    const root = opts.modelsRoot ?? defaultModelsRoot();
    const installed = await resolveInstalled(root, entry.id, opts.version);
    if (!installed) {
      throw new GenFail(
        'not-installed',
        `Backend "${entry.id}" is not installed - run \`spritebook models install ${entry.id}\` ` +
          `first (models root: ${root})`,
      );
    }
    const version = entry.versions.find((v) => v.version === installed.version);
    if (!version) {
      throw new GenFail(
        'unknown-model',
        `Installed version ${installed.version} of "${entry.id}" is no longer in the catalog - ` +
          `run \`spritebook models verify ${entry.id}\``,
      );
    }

    // 2. gates: platform, then the HARD job-time VRAM preflight
    const platform = await detectPlatform();
    const plat = gatePlatform(version, platform);
    if (!plat.ok) throw new GenFail(plat.code, plat.message);
    const vram = preflightVram(
      version.minVramGb,
      opts.detectedVramGb !== undefined ? opts.detectedVramGb : await detectVramGb(),
    );
    if (!vram.ok) throw new GenFail(vram.code, vram.message);
    if (vram.warn) {
      yield { t: 'warn', jobId, at: at(), code: `vram-${vram.status}`, message: vram.warn };
    }

    // 3. params validated against the CATALOG entry's schema, before spawning
    const params = { ...version.defaults, ...opts.params, seed: opts.seed };
    const check = validateParams(version.paramsSchema, params);
    if (!check.ok) {
      throw new GenFail(
        'invalid-params',
        `Parameters rejected by "${entry.id}": ${check.errors.join('; ')}`,
      );
    }

    // 4. workspace + content-addressed source
    const paths = workspacePaths(opts.workspace);
    // store first: it is content-addressed and creates source/ itself, so the
    // sha256 the manifest needs is known before the manifest exists
    const stored = await storeSourceImage(opts.workspace, opts.imagePath);
    let manifest = await readWorkspace(opts.workspace).catch(() => null);
    if (!manifest) {
      manifest = await createWorkspace({
        workspace: opts.workspace,
        characterId: opts.characterId as CharacterId,
        displayName: opts.characterId,
        source: {
          kind: 'image',
          originalFilename: stored.originalFilename,
          sha256: stored.sha256,
        },
      });
    }
    const resultId = nextResultId(manifest);
    const rp = resultPaths(opts.workspace, resultId);
    await Deno.mkdir(rp.dir, { recursive: true });
    yield { t: 'progress', jobId, at: at(), step: 'generate', done: 1, total: 3 };

    // 5. the backend, through the sidecar
    session = new SidecarSession({ sidecarDir: opts.sidecarDir });
    let sawMesh = false;
    let metaPath: string | undefined;
    for await (
      const e of session.run({
        jobId: `${opts.jobId}-gen` as JobEvent['jobId'],
        kind: entry.id, // catalog id IS the adapter id (one name for one backend)
        params: {
          ...params,
          imagePath: stored.storedPath,
          outDir: rp.dir,
          seed: opts.seed,
          modelDir: versionDir(root, entry.id, installed.version),
        },
      })
    ) {
      if (e.t === 'error') {
        // a catalog entry whose weights are installed but whose ADAPTER this
        // build does not ship is a known state, not a crash — say so plainly
        if (e.code === 'unknown-adapter') {
          throw new GenFail(
            'backend-unavailable',
            `Backend "${entry.id}" is installed, but this build of SpriteBook has no adapter ` +
              `for it yet, so it cannot be run. Use a backend the sidecar implements ` +
              `(\`spritebook models list\` shows what is installed; \`fixture-gen\` always works).`,
          );
        }
        throw new GenFail(
          'backend-failed',
          `Backend "${entry.id}" failed: ${e.message}`,
          e.retryable,
        );
      }
      if (e.t === 'artifact' && e.kind === 'mesh-raw') sawMesh = true;
      // An adapter that retried announces the seed it ACTUALLY used. Recording
      // the requested one instead would make "re-run exactly this" reproduce
      // the failure rather than the result — trellis2 re-samples past a
      // seed-dependent black texture, so the two genuinely differ.
      if (e.t === 'artifact' && e.kind === 'gen-meta') metaPath = e.path;
      // forward the backend's progress/warns under this job's id
      if (e.t === 'progress') {
        yield {
          t: 'progress',
          jobId,
          at: at(),
          step: `backend:${e.step}`,
          done: e.done,
          total: e.total,
        };
      } else if (e.t === 'warn') {
        yield { t: 'warn', jobId, at: at(), code: e.code, message: e.message };
      }
    }
    if (!sawMesh) {
      throw new GenFail(
        'no-mesh',
        `Backend "${entry.id}" finished without emitting a mesh-raw artifact - its adapter is ` +
          `not honoring the gen3d contract`,
      );
    }
    const rawPath = `${rp.dir}/${RAW_MODEL}`;
    await Deno.stat(rawPath).catch(() => {
      throw new GenFail(
        'no-mesh',
        `Backend "${entry.id}" announced a mesh but ${rawPath} is missing`,
      );
    });
    yield { t: 'progress', jobId, at: at(), step: 'border', done: 2, total: 3 };

    // 6. THE BORDER: everything becomes canonical glTF (D-012)
    let canonical: { bytes: Uint8Array; report: unknown };
    try {
      const imported = await importToCanonical({
        input: rawPath,
        ...(opts.declaredHeightM !== undefined ? { declaredHeightM: opts.declaredHeightM } : {}),
      });
      canonical = { bytes: imported.bytes, report: imported.report };
    } catch (err) {
      throw new GenFail(
        'border-failed',
        `The generated mesh could not be canonicalized: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await Deno.writeFile(rp.model, canonical.bytes);
    await Deno.writeTextFile(rp.preflight, JSON.stringify(canonical.report, null, 2) + '\n');

    // 7. the receipt, pinned to the CANONICAL bytes
    const gltfSha256 = await sha256Hex(canonical.bytes);
    const described = await describeMesh(canonical.bytes);
    if (described.tris < 1) {
      throw new GenFail('border-failed', 'The canonical mesh has no triangles');
    }
    // the seed the adapter settled on, when it told us; otherwise the one asked for
    const effectiveSeed = await readEffectiveSeed(metaPath, opts.seed);

    const receipt: GenerationResult = {
      id: resultId,
      backend: { modelId: entry.id, version: installed.version },
      params,
      seed: effectiveSeed,
      startedAt,
      wallTimeS: Number(((performance.now() - t0) / 1000).toFixed(3)),
      output: {
        gltfSha256,
        tris: described.tris,
        ...(described.textureRes !== undefined ? { textureRes: described.textureRes } : {}),
        kind: version.outputs?.kind ?? 'mesh',
      },
      discarded: false,
    };
    await appendGenerationResult(opts.workspace, receipt, {
      label: `Generate ${resultId} (${entry.id})`,
    });
    yield { t: 'progress', jobId, at: at(), step: 'receipt', done: 3, total: 3 };

    yield { t: 'artifact', jobId, at: at(), kind: 'gen-raw', path: rawPath };
    yield { t: 'artifact', jobId, at: at(), kind: 'gen-model', path: rp.model };
    yield { t: 'artifact', jobId, at: at(), kind: 'gen-preflight', path: rp.preflight };
    yield { t: 'artifact', jobId, at: at(), kind: 'character-manifest', path: paths.manifest };
    yield {
      t: 'done',
      jobId,
      at: at(),
      wallTimeS: Number(((performance.now() - t0) / 1000).toFixed(3)),
    };
  } catch (err) {
    const fail = err instanceof GenFail
      ? err
      : new GenFail('gen-failed', err instanceof Error ? err.message : String(err));
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: fail.code,
      message: fail.message,
      retryable: fail.retryable,
    };
  } finally {
    await session?.dispose();
  }
}

/**
 * The seed an adapter actually generated with, from its `gen-meta` artifact.
 *
 * Optional by design: only backends that can re-sample emit it, and a missing,
 * unreadable or malformed file falls back to the requested seed rather than
 * failing a generation that has already produced a mesh. A wrong seed in a
 * receipt is bad; throwing away a good mesh over bookkeeping is worse — the
 * same rule `rig` follows when its recording step fails.
 */
export async function readEffectiveSeed(
  metaPath: string | undefined,
  requested: number,
): Promise<number> {
  if (metaPath === undefined) return requested;
  try {
    const doc = JSON.parse(await Deno.readTextFile(metaPath)) as { effectiveSeed?: unknown };
    const seed = doc.effectiveSeed;
    return typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 ? seed : requested;
  } catch {
    return requested;
  }
}
