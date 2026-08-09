/**
 * `spritebook retexture` — keep the mesh, reroll the paint.
 *
 * A result you like with a texture you do not is a real and common state, and
 * the only answer before this was "generate again and hope the geometry comes
 * back as good". This takes an existing result's CANONICAL mesh, hands it back
 * to a backend that declares the `retexture` capability, and writes a NEW
 * result whose `derivedFrom` names its parent.
 *
 * ## Three deliberate choices
 *
 * **The backend is resolved by CAPABILITY, never by name.** The catalog says
 * who can retexture and which sidecar adapter runs it; this file names no
 * model. A second texturing backend is a catalog entry, not a code change
 * (D-009). The parent's own backend wins when it is capable and installed,
 * because a mesh is best re-encoded by the model that produced it.
 *
 * **The CANONICAL mesh goes in, not `raw.glb`.** Canonical is the blessed
 * geometry every downstream stage consumes and the one the user judged when
 * they decided they liked it. Note it is not necessarily metre-scaled — the
 * border only rescales when a `declaredHeightM` was given — but it IS grounded
 * (feet at Y=0), which is enough to make the adapter's frame check see a
 * backend that recentred on the origin and forgot to put it back.
 *
 * **The output goes through THE BORDER again.** Same rule as `gen`: nothing
 * becomes a result without being canonicalized, because the receipt pins
 * canonical bytes and a backend that hands back something subtly different
 * must be caught here rather than three stages later.
 *
 * ## What it does NOT promise
 *
 * The vertex buffer is not preserved — the texturing pass splits UV seams and
 * reorders faces, so vertex counts move by ~1.5%. It is the same SURFACE
 * (measured at 2.7e-4 mean deviation, spikes/trellis2/RETEXTURE-REPORT.md), not
 * the same buffer. Anything bound per-vertex — skin weights above all — must be
 * rebuilt against the new result.
 */
import {
  adapterFor,
  type Capability,
  defaultsFor,
  type GenerationResult,
  type JobEvent,
  type ModelEntry,
  type ModelVersion,
  preflightVram,
  RAW_MODEL,
  versionCan,
} from '@spritebook/schema';
import {
  appendGenerationResult,
  nextResultId,
  readWorkspace,
  resultPaths,
  SidecarSession,
  sourceImagePath,
  workspacePaths,
} from '@spritebook/core';
import {
  defaultModelsRoot,
  detectPlatform,
  detectVramGb,
  gatePlatform,
  loadCatalog,
  resolveInstalled,
  versionDir,
  virtualizationNote,
} from '@spritebook/registry';
import { importToCanonical } from '@spritebook/importer';
import { checkOpParams } from './opparams.ts';
import { describeMesh, readEffectiveSeed, sha256Hex } from './gen.ts';
import { heightOf } from './pick.ts';
import { writeResultThumb } from './thumb.ts';

const RETEXTURE: Capability = 'retexture';

export interface RetextureJobOptions {
  jobId: string;
  /** the character workspace */
  workspace: string;
  /** the result to repaint; its canonical mesh is the input */
  resultId: string;
  seed: number;
  /** backend knobs, over the catalog's per-operation defaults */
  params?: Record<string, unknown>;
  /** pin a backend; omitted -> resolved by capability */
  modelId?: string;
  version?: string;
  /** target standing height for the border (D-012) */
  declaredHeightM?: number;
  modelsRoot?: string;
  sidecarDir: string;
  catalogPath?: string;
  /** injected VRAM reading (tests); omitted -> the real probe */
  detectedVramGb?: number | null;
}

class RetextureFail extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

/**
 * Who can repaint, in preference order: the parent's own backend first.
 *
 * Exported because the CLI needs the same answer to write an honest refusal —
 * "nothing installed can retexture" has to be able to say what could.
 */
export function retextureBackends(
  models: ModelEntry[],
  preferModelId?: string,
): { entry: ModelEntry; version: ModelVersion }[] {
  const capable = models.flatMap((entry) =>
    entry.versions.filter((v) => versionCan(entry.kind, v, RETEXTURE)).map((v) => ({ entry, v }))
  );
  return capable
    .sort((a, b) => Number(b.entry.id === preferModelId) - Number(a.entry.id === preferModelId))
    .map(({ entry, v }) => ({ entry, version: v }));
}

/**
 * Repaint one result. Emits the same JobEvent stream `gen` does, so the CLI,
 * the GUI and `--json` consumers need nothing new to read it.
 *
 * Failure codes: no-such-result, no-parent-mesh, no-source-image, no-backend,
 * not-installed, platform-unsupported, vram-insufficient, invalid-params,
 * backend-unavailable, backend-failed, no-mesh, border-failed, and
 * retexture-failed for anything unclassified.
 */
export async function* runRetextureJob(
  opts: RetextureJobOptions,
): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = opts.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  const startedAt = at();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  let session: SidecarSession | undefined;
  try {
    // 1. the parent, and the mesh it is made of
    const manifest = await readWorkspace(opts.workspace);
    const parent = manifest.generation.results.find((r) => r.id === opts.resultId);
    if (!parent) {
      const ids = manifest.generation.results.map((r) => r.id).join(', ');
      throw new RetextureFail(
        'no-such-result',
        `No result "${opts.resultId}" in this workspace - it has: ${ids || '(none)'}`,
      );
    }
    // `resultPaths` is stricter than the manifest: it wants `r<n>`, while the
    // manifest admits any slug because fixtures and imports have always used
    // them. Refuse by name rather than surfacing a raw schema error.
    if (!/^r[1-9][0-9]*$/.test(parent.id)) {
      throw new RetextureFail(
        'no-such-result',
        `Result "${parent.id}" does not follow the r1, r2, ... layout, so this workspace has ` +
          `no directory for it to read or write. Only results \`gen\` created can be repainted.`,
      );
    }
    const parentPaths = resultPaths(opts.workspace, parent.id);
    const parentBytes = await Deno.readFile(parentPaths.model).catch(() => {
      throw new RetextureFail(
        'no-parent-mesh',
        `Result "${parent.id}" has no canonical mesh at ${parentPaths.model}, so there is ` +
          `nothing to repaint. The receipt survives a deleted file; the mesh does not.`,
      );
    });
    const parentHeightM = await heightOf(parentBytes);
    // the SOURCE image conditions the texture, exactly as it did for `gen` —
    // repainting from a different reference is a different feature
    const imagePath = sourceImagePath(opts.workspace, manifest);
    await Deno.stat(imagePath).catch(() => {
      // its OWN code: a `--json` consumer branching on this cannot fix a
      // missing source image the way it would fix a missing mesh
      throw new RetextureFail(
        'no-source-image',
        `The workspace's source image is missing at ${imagePath} - the texture is conditioned ` +
          `on it, so retexturing cannot proceed without it.`,
      );
    });

    // 2. a backend that says it can do this, never one named here
    const catalog = await loadCatalog(opts.catalogPath);
    const candidates = retextureBackends(catalog.models, opts.modelId ?? parent.backend.modelId);
    if (candidates.length === 0) {
      throw new RetextureFail(
        'no-backend',
        `No backend in the catalog declares the "retexture" capability, so there is nothing ` +
          `that can repaint a mesh in this build.`,
      );
    }
    if (opts.modelId && !candidates.some((c) => c.entry.id === opts.modelId)) {
      throw new RetextureFail(
        'no-backend',
        `Backend "${opts.modelId}" cannot retexture - these can: ${
          [...new Set(candidates.map((c) => c.entry.id))].join(', ')
        }`,
      );
    }
    const pool = opts.modelId ? candidates.filter((c) => c.entry.id === opts.modelId) : candidates;

    const root = opts.modelsRoot ?? defaultModelsRoot();
    // Resolve what is INSTALLED per entry, then match it against that entry's
    // capable versions. The other order — walk capable versions and ask
    // `resolveInstalled` about each — asks the same question once per version
    // and, worse, misses the case where the newest installed version cannot
    // retexture while an older installed one can: `resolveInstalled` answers
    // "the highest installed", which is not "the highest installed that can do
    // this", so the job would refuse with "install it" for something already
    // installed.
    let chosen: { entry: ModelEntry; version: ModelVersion; installedVersion: string } | undefined;
    for (const entryId of [...new Set(pool.map((c) => c.entry.id))]) {
      const installed = await resolveInstalled(root, entryId, opts.version);
      if (!installed) continue;
      const match = pool.find((c) =>
        c.entry.id === entryId && c.version.version === installed.version
      );
      if (match) {
        chosen = {
          entry: match.entry,
          version: match.version,
          installedVersion: installed.version,
        };
        break;
      }
    }
    if (!chosen) {
      const names = [...new Set(pool.map((c) => c.entry.id))];
      // when this process's %LOCALAPPDATA% is a container overlay, SAY SO (D-039)
      throw new RetextureFail(
        'not-installed',
        `Nothing that can retexture is installed - run \`spritebook models install ${
          names[0]
        }\` (capable backends: ${
          names.join(', ')
        }; models root: ${root}).${await virtualizationNote()}`,
      );
    }
    const { entry, version } = chosen;

    // 3. gates, in `gen`'s order: platform, then the hard VRAM preflight
    const plat = gatePlatform(version, await detectPlatform());
    if (!plat.ok) throw new RetextureFail(plat.code, plat.message);
    const vram = preflightVram(
      version.minVramGb,
      opts.detectedVramGb !== undefined ? opts.detectedVramGb : await detectVramGb(),
    );
    if (!vram.ok) throw new RetextureFail(vram.code, vram.message);
    if (vram.warn) {
      yield { t: 'warn', jobId, at: at(), code: `vram-${vram.status}`, message: vram.warn };
    }

    // 4. params: the RETEXTURE defaults, which are not the gen ones
    const check = checkOpParams(entry.id, version, RETEXTURE, {
      ...defaultsFor(version, RETEXTURE),
      ...opts.params,
      seed: opts.seed,
    });
    if (!check.ok) throw new RetextureFail('invalid-params', check.message);
    const params = check.params;

    const resultId = nextResultId(manifest);
    const rp = resultPaths(opts.workspace, resultId);
    await Deno.mkdir(rp.dir, { recursive: true });
    yield { t: 'progress', jobId, at: at(), step: 'retexture', done: 1, total: 3 };

    // 5. the backend
    session = new SidecarSession({ sidecarDir: opts.sidecarDir });
    let sawMesh = false;
    let metaPath: string | undefined;
    for await (
      const e of session.run({
        jobId: `${opts.jobId}-retexture` as JobEvent['jobId'],
        kind: adapterFor(entry.id, version, RETEXTURE),
        params: {
          ...params,
          meshPath: parentPaths.model,
          imagePath,
          outDir: rp.dir,
          seed: opts.seed,
          modelDir: versionDir(root, entry.id, chosen.installedVersion),
        },
      })
    ) {
      if (e.t === 'error') {
        if (e.code === 'unknown-adapter') {
          throw new RetextureFail(
            'backend-unavailable',
            `Backend "${entry.id}" declares the retexture capability and its weights are ` +
              `installed, but this build of SpriteBook ships no adapter for it.`,
          );
        }
        throw new RetextureFail(
          'backend-failed',
          `Backend "${entry.id}" failed: ${e.message}`,
          e.retryable,
        );
      }
      if (e.t === 'artifact' && e.kind === 'mesh-raw') sawMesh = true;
      if (e.t === 'artifact' && e.kind === 'gen-meta') metaPath = e.path;
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
      throw new RetextureFail(
        'no-mesh',
        `Backend "${entry.id}" finished without emitting a mesh-raw artifact`,
      );
    }
    const rawPath = `${rp.dir}/${RAW_MODEL}`;
    await Deno.stat(rawPath).catch(() => {
      throw new RetextureFail(
        'no-mesh',
        `Backend "${entry.id}" announced a mesh but ${rawPath} is missing`,
      );
    });
    yield { t: 'progress', jobId, at: at(), step: 'border', done: 2, total: 3 };

    // 6. THE BORDER, same as gen: a receipt pins canonical bytes or nothing
    let canonical: { bytes: Uint8Array; report: unknown };
    try {
      const imported = await importToCanonical({
        input: rawPath,
        // the PARENT's own height, measured, not the manifest's
        // `canonicalMesh.heightM` — that is whichever result was PICKED, and
        // repainting r2 while r1 is picked would silently rescale the child to
        // a different mesh's size while its receipt claims it kept r2's shape
        ...(opts.declaredHeightM !== undefined
          ? { declaredHeightM: opts.declaredHeightM }
          : parentHeightM > 0
          ? { declaredHeightM: parentHeightM }
          : {}),
      });
      canonical = { bytes: imported.bytes, report: imported.report };
    } catch (err) {
      throw new RetextureFail(
        'border-failed',
        `The retextured mesh could not be canonicalized: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await Deno.writeFile(rp.model, canonical.bytes);
    await Deno.writeTextFile(rp.preflight, JSON.stringify(canonical.report, null, 2) + '\n');

    // W5b: a repaint earns a card too - same best-effort front view as gen
    const thumbPath = `${rp.dir}/thumb.png`;
    if (
      await writeResultThumb(rp.model, await heightOf(canonical.bytes), thumbPath) === 'written'
    ) {
      yield { t: 'artifact', jobId, at: at(), kind: 'gen-thumb', path: thumbPath };
    }

    // 7. the receipt, naming its parent
    const gltfSha256 = await sha256Hex(canonical.bytes);
    const described = await describeMesh(canonical.bytes);
    if (described.tris < 1) {
      throw new RetextureFail('border-failed', 'The retextured mesh has no triangles');
    }
    if (gltfSha256 === parent.output.gltfSha256) {
      // identical bytes mean the backend returned its input untouched: the
      // result would be a duplicate receipt wearing a new id
      yield {
        t: 'warn',
        jobId,
        at: at(),
        code: 'texture-unchanged',
        message: `The retextured mesh is byte-identical to "${parent.id}" - the backend appears ` +
          `to have returned its input unchanged. The result is still recorded; a different ` +
          `--seed is the thing to try.`,
      };
    }
    const effectiveSeed = await readEffectiveSeed(metaPath, opts.seed);

    const receipt: GenerationResult = {
      id: resultId,
      backend: { modelId: entry.id, version: chosen.installedVersion },
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
      derivedFrom: parent.id,
    };
    await appendGenerationResult(opts.workspace, receipt, {
      label: `Retexture ${parent.id} -> ${resultId} (${entry.id}, seed ${effectiveSeed})`,
    });
    yield { t: 'progress', jobId, at: at(), step: 'receipt', done: 3, total: 3 };

    const paths = workspacePaths(opts.workspace);
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
    const fail = err instanceof RetextureFail
      ? err
      : new RetextureFail('retexture-failed', err instanceof Error ? err.message : String(err));
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
