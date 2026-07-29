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
  adapterFor,
  type CharacterId,
  defaultsFor,
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
import { componentsOfFile, disconnectedWarning, importToCanonical } from '@spritebook/importer';
import { NodeIO } from '@gltf-transform/core';
import { decode as decodePng } from 'fast-png';
import { heightOf } from './pick.ts';

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

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Triangle count + texture resolution of canonical bytes, for the receipt. */
export async function describeMesh(
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

    // 3. params validated against the CATALOG entry's schema, before spawning.
    // `defaultsFor`, not `version.defaults`: a parameter can differ per
    // operation on one model (trellis2's seed-retry budget is 2 here and 5 for
    // retexture, because the same decoder fails 7x more often there).
    const params = { ...defaultsFor(version, 'gen3d'), ...opts.params, seed: opts.seed };
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
        // catalog data: `trellis2-4b` is run by the `trellis2` adapter, and the
        // two names have never matched
        kind: adapterFor(entry.id, version, 'gen3d'),
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
    // A generated mesh arrives at whatever scale the backend chose - TRELLIS.2
    // normalises its LONGEST axis to 1.0 - and the border only rescales when a
    // declaredHeightM says what the character actually is. Everything downstream
    // then inherits that arbitrary number: `bake` frames in pixelsPerMeter, so a
    // 1 m character lands ~20 px tall in a 64 px cell, its outline swallows the
    // silhouette, and the sprite ships nearly black. This is the one place that
    // knows the height was never declared, so it is the one place that can say
    // so. It does NOT invent a default: guessing 1.7 m would be right for a
    // person and wrong for a chibi, a prop or a robot, and it would rescale the
    // mesh every later stage sees on the strength of that guess.
    if (opts.declaredHeightM === undefined) {
      const measured = await heightOf(canonical.bytes);
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'scale-undeclared',
        message: `no --height was given, so this character kept the backend's own scale and ` +
          `stands ${measured.toFixed(3)} m tall. That is the number every later stage believes: ` +
          `\`bake\` frames at pixelsPerMeter, so the sprite's size in its cell follows directly ` +
          `from it. Re-run with \`--height <metres>\` if that is not the size you meant.`,
      };
    }

    // How many body-sized pieces the backend actually produced. This is a
    // property of the MESH, so it is knowable HERE - one image, one glb - and
    // waiting for someone to run `rig` only means finding out ~90 s of GPU
    // later. Two things come out of it: a warn now, and a number on the receipt
    // that lets `pick` compare siblings.
    //
    // Measured, and the reason the number is worth keeping: the SAME image at
    // different seeds lands on different answers. `robot-astro` generated two
    // bodies at seed 7 (60.4% / 20.0% - its hands came off) and one body at
    // seeds 100 and 201 (78.9%, 89.8%). Bulma was one body at every seed tried.
    // So "generate a few and take the connected one" is a real strategy, and it
    // needs this recorded per result to be possible at all.
    const shells = await componentsOfFile(rp.model);
    const detached = disconnectedWarning(shells);
    if (detached) {
      yield { t: 'warn', jobId, at: at(), code: 'mesh-disconnected', message: detached };
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
        bodies: shells.significant.length,
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
