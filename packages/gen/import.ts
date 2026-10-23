import { promises as fs } from 'node:fs';
import { basename, extname } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { importToCanonical } from '@spritebook/importer';
import {
  commitManifest,
  createWorkspace,
  sha256Bytes,
  workspaceJob,
  workspacePaths,
} from '@spritebook/core';
import { canonicalJson, type JobEvent, type JsonPatchOp } from '@spritebook/schema';
import { heightOf } from './pick.ts';

export interface ImportJobOptions {
  jobId: string;
  workspace: string;
  input: string;
  characterId: string;
  displayName: string;
  heightM?: number;
}

/** Preserve authored skinning at the importer border; never fabricate a generation receipt. */
async function* executeImport(opts: ImportJobOptions): AsyncIterable<JobEvent> {
  const jobId = opts.jobId as JobEvent['jobId'];
  const at = () => new Date().toISOString();
  const start = performance.now();
  yield { t: 'started', jobId, at: at() };
  try {
    const source = new Uint8Array(await fs.readFile(opts.input));
    const imported = await importToCanonical({ input: opts.input, declaredHeightM: opts.heightM });
    const doc = await new NodeIO().readBinary(imported.bytes);
    const skins = doc.getRoot().listSkins();
    if (skins.length > 1) {
      throw new Error('This character workflow supports one skin. Import one character at a time.');
    }
    const heightM = await heightOf(imported.bytes);
    if (!(heightM > 0)) throw new Error('The imported mesh has no standing height.');
    const sha256 = await sha256Bytes(source);
    const paths = workspacePaths(opts.workspace, opts.characterId);
    await createWorkspace({
      ...opts,
      source: { kind: 'mesh', originalFilename: basename(opts.input), sha256 },
    });
    const staged = `${paths.sourceDir}/${await sha256Bytes(imported.bytes)}.glb`;
    await fs.writeFile(`${paths.sourceDir}/${sha256}${extname(opts.input).toLowerCase()}`, source);
    await fs.writeFile(staged, imported.bytes);
    await fs.writeFile(`${paths.sourceDir}/preflight.json`, canonicalJson(imported.report));
    const op: JsonPatchOp[] = [
      {
        op: 'add',
        path: '/source/importedVia',
        value: { tool: imported.provenance.tool, version: imported.provenance.generator },
      },
      {
        op: 'add',
        path: '/canonicalMesh',
        value: {
          gltfSha256: await sha256Bytes(imported.bytes),
          heightM,
          texturedBy: 'source',
          reprojected: false,
        },
      },
    ];
    if (skins.length) {
      op.push({
        op: 'add',
        path: '/rig',
        value: {
          track: 'B',
          backend: { modelId: 'imported-rig', version: imported.provenance.generator },
          skeletonProfile: 'generic',
          jointCount: skins[0].listJoints().length,
          jointEdits: [],
          orientationFixes: [],
          accepted: false,
        },
      });
    }
    await commitManifest(
      paths.manifest,
      () => ({ op, label: 'Import character mesh' }),
      undefined,
      staged,
    );
    yield { t: 'artifact', jobId, at: at(), kind: 'canonical-mesh', path: paths.canonicalModel };
    yield {
      t: 'warn',
      jobId,
      at: at(),
      code: 'motion-review-required',
      message: skins.length
        ? 'Existing rig preserved. Review walk and jump before accepting it; import does not certify motion quality.'
        : 'Static mesh imported. Build a rig, then review walk and jump before baking.',
    };
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - start) / 1000 };
  } catch (error) {
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: 'import-failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}

export function runImportJob(opts: ImportJobOptions): AsyncIterable<JobEvent> {
  return workspaceJob(opts.workspace, () => executeImport(opts));
}
