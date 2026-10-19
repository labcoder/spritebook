import { promises as fs } from 'node:fs';
/**
 * The importer border entry: everything becomes canonical glTF (D-012),
 * deterministically. Pure function + JobEvent-emitting executor; the
 * PreflightReport is written next to the canonical asset and announced as an
 * `artifact` event (audit 5 / skill "import report").
 */
import type { Document } from '@gltf-transform/core';
import type { JobEvent, JobSpec, PreflightReport } from '@spritebook/schema';
import { canonicalJson, parseWith, PreflightReportSchema } from '@spritebook/schema';
import { detectVrm, formatFromPath, type SourceFormat, type VrmVersion } from './detect.ts';
import { canonicalize, type CanonNote, sceneBounds } from './canonicalize.ts';
import { FBX_CONVERTER, parseFbx, threeSceneToDocument } from './fbx.ts';
import { GENERATOR, getIO, writeCanonical } from './io.ts';
import { ImportError, toImportError } from './errors.ts';

export interface ImportOptions {
  input: string;
  /** target standing height; omit to keep source scale */
  declaredHeightM?: number;
  /** injectable clock for deterministic event tests */
  now?: () => string;
}

export interface ImportResult {
  bytes: Uint8Array;
  report: PreflightReport;
  provenance: {
    format: SourceFormat;
    vrm: VrmVersion;
    tool: 'gltf-transform' | 'obj2gltf' | 'three-fbx';
    converter?: string;
    generator: string;
  };
}

async function readAsDocument(
  input: string,
  bytes: Uint8Array,
  format: SourceFormat,
): Promise<{ doc: Document; tool: ImportResult['provenance']['tool']; converter?: string }> {
  const io = await getIO();
  switch (format) {
    case 'glb':
      return { doc: await io.readBinary(bytes), tool: 'gltf-transform' };
    case 'gltf': {
      // .gltf may reference sibling files; route through the path API
      return { doc: await io.read(input), tool: 'gltf-transform' };
    }
    case 'obj': {
      const { default: obj2gltf } = await import('obj2gltf');
      const glb = await obj2gltf(input, { binary: true });
      return {
        doc: await io.readBinary(new Uint8Array(glb)),
        tool: 'obj2gltf',
        converter: 'obj2gltf@3',
      };
    }
    case 'fbx': {
      const scene = parseFbx(bytes, input);
      return {
        doc: threeSceneToDocument(scene, input),
        tool: 'three-fbx',
        converter: FBX_CONVERTER,
      };
    }
  }
}

/** Import one source file to canonical glTF bytes + preflight report. */
export async function importToCanonical(opts: ImportOptions): Promise<ImportResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const format = formatFromPath(opts.input);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(opts.input));
  } catch {
    throw new ImportError(`Cannot read "${opts.input}" - does the file exist?`);
  }

  const vrm = detectVrm(bytes, format, opts.input);
  if (vrm === 'vrm1') {
    // VRM 1.0 already faces +Z; extension data is shed at the border like 0.x
  }

  let doc: Document;
  let tool: ImportResult['provenance']['tool'];
  let converter: string | undefined;
  try {
    ({ doc, tool, converter } = await readAsDocument(opts.input, bytes, format));
  } catch (err) {
    throw toImportError(err, `${opts.input}: read failed`);
  }

  const notes: CanonNote[] = await canonicalize(doc, {
    label: opts.input,
    declaredHeightM: opts.declaredHeightM,
    rotate180Y: vrm === 'vrm0',
  });

  const out = await writeCanonical(doc);
  const bounds = sceneBounds(doc);

  const report = parseWith(PreflightReportSchema, {
    at: now(),
    checks: [
      {
        id: 'loaded',
        status: 'ok',
        message: `Loaded ${format}${vrm !== 'none' ? ` (${vrm})` : ''} via ${tool}` +
          `${converter ? ` [${converter}]` : ''}: ` +
          `${doc.getRoot().listMeshes().length} meshes, ` +
          `${doc.getRoot().listSkins().length} skins, ` +
          `${doc.getRoot().listNodes().length} nodes`,
      },
      ...notes,
      {
        id: 'bounds',
        status: 'ok',
        message: `Final bounds y: [${bounds.min[1].toFixed(5)}, ${bounds.max[1].toFixed(5)}], ` +
          `height ${(bounds.max[1] - bounds.min[1]).toFixed(4)} m`,
      },
    ],
  }, 'PreflightReport');

  return { bytes: out, report, provenance: { format, vrm, tool, converter, generator: GENERATOR } };
}

/**
 * Executor shape for the core queue: emits progress + artifacts + done.
 *
 * ## Cancellation
 *
 * The signal is checked at the checkpoints between the phases that can outlive
 * a cancel — the read/canonicalize pass, and the write. A cancelled run emits
 * ONE terminal event, the `cancelled` error the queue expects (queue.ts checks
 * `signal.aborted` before `sawDone`, so an executor that yields `done` anyway
 * makes the queue append a second terminal event and the log drawer renders
 * `done` followed by `error` for a single job). Anything already written is
 * removed on the way out: a cancelled import that leaves canonical.glb behind
 * is a workspace claiming an import that never finished.
 */
export function makeImportExecutor(opts: Omit<ImportOptions, 'now'> & { outDir: string }) {
  return async function* importExecutor(
    spec: JobSpec,
    signal: AbortSignal,
  ): AsyncIterable<JobEvent> {
    const now = () => new Date().toISOString();
    const { jobId } = spec;
    const t0 = Date.now();
    const written: string[] = [];
    const cancelled = (): JobEvent => ({
      t: 'error',
      jobId,
      at: now(),
      code: 'cancelled',
      message: 'Job cancelled',
      retryable: false,
    });
    const discard = async () => {
      for (const path of written) {
        await fs.rm(path).catch(() => {});
      }
    };

    yield { t: 'started', jobId, at: now() };
    try {
      if (signal.aborted) {
        yield cancelled();
        return;
      }
      yield { t: 'progress', jobId, at: now(), step: 'read', done: 1, total: 3 };
      const result = await importToCanonical(opts);
      // the long pass is where a cancel actually lands; refusing here is what
      // keeps the writes below from happening at all
      if (signal.aborted) {
        yield cancelled();
        return;
      }
      yield { t: 'progress', jobId, at: now(), step: 'canonicalize', done: 2, total: 3 };

      await fs.mkdir(opts.outDir, { recursive: true });
      const glbPath = `${opts.outDir}/canonical.glb`;
      const reportPath = `${opts.outDir}/preflight.json`;
      await fs.writeFile(glbPath, result.bytes);
      written.push(glbPath);
      await fs.writeFile(reportPath, canonicalJson(result.report));
      written.push(reportPath);
      // a cancel landing mid-write leaves half an import on disk, so the files
      // go back before the terminal event claims nothing happened
      if (signal.aborted) {
        await discard();
        yield cancelled();
        return;
      }
      yield { t: 'progress', jobId, at: now(), step: 'write', done: 3, total: 3 };
      yield { t: 'artifact', jobId, at: now(), kind: 'canonical-gltf', path: glbPath };
      yield { t: 'artifact', jobId, at: now(), kind: 'preflight', path: reportPath };

      const failed = result.report.checks.filter((c) => c.status === 'fail');
      for (const check of result.report.checks.filter((c) => c.status === 'warn')) {
        yield { t: 'warn', jobId, at: now(), code: check.id, message: check.message };
      }
      if (failed.length > 0) {
        yield {
          t: 'error',
          jobId,
          at: now(),
          code: 'preflight-failed',
          message: failed.map((c) => c.message).join('; '),
          retryable: false,
        };
        return;
      }
      yield { t: 'done', jobId, at: now(), wallTimeS: (Date.now() - t0) / 1000 };
    } catch (err) {
      // a cancel that surfaced as a throw is still a cancel, not an import
      // failure - reporting it as `import-failed` would send the queue down
      // the retry path for work the user asked to stop
      if (signal.aborted) {
        await discard();
        yield cancelled();
        return;
      }
      const clean = toImportError(err, 'import failed');
      yield {
        t: 'error',
        jobId,
        at: now(),
        code: 'import-failed',
        message: clean.message,
        retryable: false,
      };
    }
  };
}
