import { promises as fs } from 'node:fs';
/**
 * @spritebook/export - Godot / Aseprite / TexturePacker / strips, pure
 * projections of the BakeManifest (D-010). The seam: an ExportJobSpec (plain
 * data) in; files under `outDir/<target>/` + a JobEvent stream out. Exporters
 * never read the clock and never project volatile manifest fields, so exporting
 * an unchanged bake is byte-stable (proven per exporter and again at this seam).
 */
import type { BakeManifest, ExportTargetId, JobEvent } from '@spritebook/schema';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import { DEFAULT_FPS, type Exporter } from '@spritebook/pack/contracts';
import { exportGodot } from './godot.ts';
import { exportStrips } from './strips.ts';
import { exportAseprite } from './aseprite.ts';
import { exportTexturePacker } from './texturepacker.ts';
import { exportModel } from './model.ts';
import { assertNoSplitAnimations } from './split-guard.ts';
export { exportModel } from './model.ts';

export { exportAseprite } from './aseprite.ts';
export { exportGodot } from './godot.ts';
export { exportStrips } from './strips.ts';
export { exportTexturePacker } from './texturepacker.ts';
export { parseTres, validateTres } from './tres-parse.ts';

export const EXPORTERS: Record<ExportTargetId, Exporter> = {
  godot: exportGodot,
  aseprite: exportAseprite,
  texturepacker: exportTexturePacker,
  strips: exportStrips,
};

export interface ExportJobSpec {
  jobId: string;
  /** a bake dir produced by runBakeJob (manifest.json + atlas pages) */
  bakeDir?: string;
  /** Independent of sprite exporters: canonical GLB and embedded textures. */
  modelPath?: string;
  outDir: string;
  targets: ExportTargetId[];
  fps?: number;
}

/** Project one bake through the selected exporters, one subdir per target. */
export async function* runExportJob(spec: ExportJobSpec): AsyncIterable<JobEvent> {
  const at = () => new Date().toISOString();
  const jobId = spec.jobId as JobEvent['jobId'];
  const t0 = performance.now();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };

  try {
    if (spec.targets.length === 0 && !spec.modelPath) throw new Error('no export targets given');
    if (spec.fps !== undefined && (!Number.isFinite(spec.fps) || spec.fps <= 0)) {
      // validated ONCE at the seam so every target behaves identically —
      // texturepacker ignores fps by design and would otherwise accept -5
      throw new Error(`fps must be positive and finite, got ${spec.fps}`);
    }
    if (spec.targets.length && !spec.bakeDir) {
      throw new Error('Sprite exports need a bake directory');
    }
    const manifest: BakeManifest | undefined = spec.targets.length
      ? parseWith(
        BakeManifestSchema,
        JSON.parse(await fs.readFile(`${spec.bakeDir}/manifest.json`, 'utf8')),
        'BakeManifest',
      )
      : undefined;
    const targets = [...new Set(spec.targets)];
    const opts = { fps: spec.fps ?? DEFAULT_FPS };
    for (const target of targets) {
      if (target === 'texturepacker' || target === 'aseprite') {
        assertNoSplitAnimations(manifest!, target);
      }
    }

    let done = 0;
    for (const target of targets) {
      const targetDir = `${spec.outDir}/${target}`;
      await EXPORTERS[target](manifest!, spec.bakeDir!, targetDir, opts);
      done++;
      yield { t: 'progress', jobId, at: at(), step: target, done, total: targets.length };
      yield { t: 'artifact', jobId, at: at(), kind: `export-${target}`, path: targetDir };
    }
    if (spec.modelPath) {
      const targetDir = `${spec.outDir}/model`;
      await exportModel(spec.modelPath, targetDir);
      yield { t: 'artifact', jobId, at: at(), kind: 'export-model', path: targetDir };
    }
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - t0) / 1000 };
  } catch (err) {
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: 'export-failed',
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    };
  }
}
