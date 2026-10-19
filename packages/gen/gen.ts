import { workspaceJob } from '@spritebook/core';
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
 * The first check asks for THIS operation's knobs (checkOpParams), so the two
 * locks refuse the same set and a retexture-only knob is named here rather
 * than dying vaguely a process later.
 */
import {
  adapterFor,
  type CharacterId,
  defaultsFor,
  type GenerationResult,
  type GenJobSpec,
  type JobEvent,
  preflightVram,
} from '@spritebook/schema';
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
import { acquireVramLeaseEvents, type VramLease } from '@spritebook/core';
import {
  detectVramGb,
  executionVram,
  gatePlatform,
  loadCatalog,
  resolvePinnedInstalled,
  verifyExecutionModel,
  versionDir,
  virtualizationNote,
} from '@spritebook/registry';
import { defaultModelsRoot, detectPlatform } from '@spritebook/registry';
import { componentsOfFile, disconnectedWarning, importToCanonical } from '@spritebook/importer';
import { NodeIO } from '@gltf-transform/core';
import { decode as decodePng } from 'fast-png';
import { heightOf } from './pick.ts';
import { writeResultThumb } from './thumb.ts';
import { rankCandidates, rankingMessage } from './candidates.ts';
import { checkOpParams } from './opparams.ts';

export interface GenJobOptions extends GenJobSpec {
  /** N candidates in ONE sidecar job (the model loads once); every candidate
   * becomes a receipt and a ranked suggestion is emitted. Default 1. */
  candidates?: number;
  /** models root override (tests, and `--models-dir`) */
  modelsRoot?: string;
  /** the uv sidecar project dir */
  sidecarDir: string;
  /** injected catalog (tests); omitted -> the bundled one */
  catalogPath?: string;
  pinsPath?: string;
  /** injected VRAM reading (tests); omitted -> the real probe */
  detectedVramGb?: number | null;
  /**
   * Shared VRAM-lease directory. Defaults to the machine-wide one; tests and
   * anyone running two isolated SpriteBooks on one box override it.
   */
  vramLeaseDir?: string;
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
async function* executeGenJob(opts: GenJobOptions): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = opts.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  const startedAt = at();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  let session: SidecarSession | undefined;
  let lease: VramLease | undefined;
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
    const installed = await resolvePinnedInstalled(root, entry.id, opts.version, opts);
    if (!installed) {
      // when this process's %LOCALAPPDATA% is a container overlay, SAY SO -
      // that split is what the old blind probe never caught (D-039)
      throw new GenFail(
        'not-installed',
        `Backend "${entry.id}" is not installed - run \`spritebook models install ${entry.id}\` ` +
          `first (models root: ${root}).${await virtualizationNote()}`,
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

    // 3. params validated against the CATALOG entry's schema, before spawning.
    // `defaultsFor`, not `version.defaults`: a parameter can differ per
    // operation on one model (trellis2's seed-retry budget is 2 here and 5 for
    // retexture, because the same decoder fails 7x more often there).
    const check = checkOpParams(entry.id, version, 'gen3d', {
      ...defaultsFor(version, 'gen3d'),
      ...opts.params,
      seed: opts.seed,
      ...(opts.candidates !== undefined ? { candidates: opts.candidates } : {}),
    });
    if (!check.ok) throw new GenFail('invalid-params', check.message);
    const params = check.params;

    // 2. gates: platform, then the HARD job-time VRAM preflight
    const platform = await detectPlatform();
    const plat = gatePlatform(version, platform);
    if (!plat.ok) throw new GenFail(plat.code, plat.message);
    const detectedVramGb = opts.detectedVramGb !== undefined
      ? opts.detectedVramGb
      : await detectVramGb();
    const claimGb = executionVram(version, 'gen3d', params);
    const vram = preflightVram(claimGb, detectedVramGb);
    if (!vram.ok) throw new GenFail(vram.code, vram.message);
    if (vram.warn) {
      yield { t: 'warn', jobId, at: at(), code: `vram-${vram.status}`, message: vram.warn };
    }

    await verifyExecutionModel({
      root,
      catalog,
      entry,
      version,
      receipt: installed.receipt,
      platform,
    });

    // 2b. the machine-wide lease. The preflight above asks "could this card
    // ever run this model"; the lease asks "is the card free RIGHT NOW", which
    // is a different question the moment a second SpriteBook process exists —
    // and the Studio spawns one per job. Held for the whole sidecar run and
    // released in the `finally` below, on every exit path.
    lease = yield* acquireVramLeaseEvents({
      gb: claimGb ?? 0,
      jobId,
      budgetGb: detectedVramGb,
      ...(opts.vramLeaseDir !== undefined ? { dir: opts.vramLeaseDir } : {}),
    }, at);

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
    const rawPaths: string[] = [];
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
      if (e.t === 'artifact' && e.kind === 'mesh-raw') {
        sawMesh = true;
        rawPaths.push(e.path);
      }
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
    // The adapter emits one mesh-raw per candidate, in index order (candidate
    // 0 is `raw.glb`, the historical contract). Candidate i's requested seed is
    // seed + i * SEED_STRIDE - the cross-adapter convention both adapters and
    // this fallback share.
    if (rawPaths.length === 0) {
      throw new GenFail('no-mesh', `Backend "${entry.id}" announced a mesh but no path arrived`);
    }
    const wanted = typeof params.candidates === 'number' ? params.candidates : 1;
    if (rawPaths.length !== wanted) {
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'candidates-short',
        message: `asked for ${wanted} candidates and received ${rawPaths.length} - ` +
          `ranking what arrived.`,
      };
    }

    const made: Array<{
      resultId: string;
      modelPath: string;
      bodies: number;
      seed: number;
    }> = [];
    let m = manifest;
    for (let i = 0; i < rawPaths.length; i++) {
      const cid = i === 0 ? resultId : nextResultId(m);
      const crp = i === 0 ? rp : resultPaths(opts.workspace, cid);
      await Deno.mkdir(crp.dir, { recursive: true });
      // candidate raws land in candidate 0's dir; each moves home as its
      // result is minted, keeping results/<id>/raw.glb the invariant
      if (rawPaths[i] !== crp.raw) await Deno.rename(rawPaths[i], crp.raw);
      await Deno.stat(crp.raw).catch(() => {
        throw new GenFail(
          'no-mesh',
          `Backend "${entry.id}" announced a mesh but ${crp.raw} is missing`,
        );
      });
      yield {
        t: 'progress',
        jobId,
        at: at(),
        step: rawPaths.length > 1 ? `border:${cid}` : 'border',
        done: 2,
        total: 3,
      };

      // 6. THE BORDER: everything becomes canonical glTF (D-012)
      let canonical: { bytes: Uint8Array; report: unknown };
      try {
        const imported = await importToCanonical({
          input: crp.raw,
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
      await Deno.writeFile(crp.model, canonical.bytes);
      await Deno.writeTextFile(crp.preflight, JSON.stringify(canonical.report, null, 2) + '\n');

      // W5b: the candidates screen judges meshes, not numbers - a front-view
      // lit render per result, through the bake's own pipeline. Best-effort:
      // no GPU or a render failure means no thumb, never a failed gen.
      const thumbPath = `${crp.dir}/thumb.png`;
      const thumbHeight = await heightOf(canonical.bytes);
      if (await writeResultThumb(crp.model, thumbHeight, thumbPath) === 'written') {
        yield { t: 'artifact', jobId, at: at(), kind: 'gen-thumb', path: thumbPath };
      }

      // 7. the receipt, pinned to the CANONICAL bytes
      const gltfSha256 = await sha256Hex(canonical.bytes);
      const described = await describeMesh(canonical.bytes);
      if (described.tris < 1) {
        throw new GenFail('border-failed', 'The canonical mesh has no triangles');
      }
      // A generated mesh arrives at whatever scale the backend chose - TRELLIS.2
      // normalises its LONGEST axis to 1.0 - and the border only rescales when a
      // declaredHeightM says what the character actually is. Everything
      // downstream then inherits that arbitrary number: bake frames in
      // pixelsPerMeter, so a 1 m character lands ~20 px tall in a 64 px cell.
      // Said ONCE, not once per candidate.
      if (opts.declaredHeightM === undefined && i === 0) {
        const measured = await heightOf(canonical.bytes);
        yield {
          t: 'warn',
          jobId,
          at: at(),
          code: 'scale-undeclared',
          message: `no --height was given, so this character kept the backend's own scale and ` +
            `stands ${measured.toFixed(3)} m tall. That is the number every later stage ` +
            `believes: \`bake\` frames at pixelsPerMeter, so the sprite's size in its cell ` +
            `follows directly from it. Re-run with \`--height <metres>\` if that is not the ` +
            `size you meant.`,
        };
      }

      // How many body-sized pieces this candidate came back as - the selection
      // signal `pick` compares (it varies by seed: robot-astro was two bodies
      // at seed 7 and one at 100/201).
      const shells = await componentsOfFile(crp.model);
      const detached = disconnectedWarning(shells);
      if (detached) {
        yield { t: 'warn', jobId, at: at(), code: 'mesh-disconnected', message: detached };
      }

      // the seed the adapter settled on, when it told us; otherwise the
      // stride convention's request for this candidate
      const effectiveSeed = await readEffectiveSeed(metaPath, opts.seed + i * SEED_STRIDE, i);

      const receipt: GenerationResult = {
        id: cid,
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
      m = await appendGenerationResult(opts.workspace, receipt, {
        label: `Generate ${cid} (${entry.id})`,
      });
      yield { t: 'progress', jobId, at: at(), step: 'receipt', done: 3, total: 3 };

      yield { t: 'artifact', jobId, at: at(), kind: 'gen-raw', path: crp.raw };
      yield { t: 'artifact', jobId, at: at(), kind: 'gen-model', path: crp.model };
      yield { t: 'artifact', jobId, at: at(), kind: 'gen-preflight', path: crp.preflight };
      made.push({
        resultId: cid,
        modelPath: crp.model,
        bodies: shells.significant.length,
        seed: effectiveSeed,
      });
    }

    // 8. candidates only: rank what was made and SUGGEST - the user picks
    if (made.length > 1) {
      const ranked = await rankCandidates(made, stored.storedPath);
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'candidates-ranked',
        message: rankingMessage(ranked),
      };
    }

    yield { t: 'artifact', jobId, at: at(), kind: 'character-manifest', path: paths.manifest };
    yield {
      t: 'done',
      jobId,
      at: at(),
      wallTimeS: Number(((performance.now() - t0) / 1000).toFixed(3)),
    };
  } catch (err) {
    const fail = err instanceof GenFail ? err : new GenFail(
      (err as { code?: string }).code ?? 'gen-failed',
      err instanceof Error ? err.message : String(err),
    );
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
    // released before the process exits, not after: a claim that outlives its
    // job shrinks the machine's budget until its heartbeat lapses
    await lease?.release();
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
  candidate = 0,
): Promise<number> {
  if (metaPath === undefined) return requested;
  try {
    const doc = JSON.parse(await Deno.readTextFile(metaPath)) as {
      effectiveSeed?: unknown;
      candidates?: Array<{ effectiveSeed?: unknown }>;
    };
    // candidates carry their own entries; candidate 0 also mirrors the legacy
    // top-level field, so pre-candidates gen-metas keep reading correctly
    const seed = doc.candidates?.[candidate]?.effectiveSeed ??
      (candidate === 0 ? doc.effectiveSeed : undefined);
    return typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 ? seed : requested;
  } catch {
    return requested;
  }
}

/**
 * Candidate i's requested seed is `seed + i * SEED_STRIDE` — the convention
 * every adapter implements, wide enough that a collapse-retry ladder (+1
 * steps) can never walk one candidate into another's range. This constant is
 * the FALLBACK for adapters that emit no gen-meta (fixture-gen); real backends
 * record the effective seed per candidate and win.
 */
export const SEED_STRIDE = 1000;

export function runGenJob(opts: GenJobOptions): AsyncIterable<JobEvent> {
  return workspaceJob(opts.workspace, () => executeGenJob(opts));
}
