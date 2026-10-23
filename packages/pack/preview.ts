import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, type JobEvent, RENDER_PASSES } from '@spritebook/schema';
import { sha256Hex } from '@spritebook/core';
import { RENDERER_VERSION, runRenderJob } from '@spritebook/render';
import { styleFromAovs } from '@spritebook/style';
import { writePoses } from '@spritebook/anim';
import { type BakeJobSpec, buildCacheInputs, prepareClips } from './bake.ts';

/** A read-only frame preview over the exact bake sampling, framing and style path. */
export async function* runLookPreview(
  spec: BakeJobSpec & { direction: number; frameIndex: number; outDir: string },
): AsyncIterable<JobEvent> {
  const jobId = spec.jobId as JobEvent['jobId'], at = () => new Date().toISOString();
  yield { t: 'queued', jobId, at: at() };
  yield { t: 'started', jobId, at: at() };
  let scratch: string | undefined;
  const started = performance.now();
  try {
    const binding = spec.clips?.[0];
    if (!binding || spec.clips?.length !== 1) {
      throw new Error('Look preview needs one animation clip');
    }
    if (
      !Number.isInteger(spec.direction) || spec.direction < 0 ||
      spec.direction >= spec.camera.directions
    ) {
      throw new Error(`Direction must be between 0 and ${spec.camera.directions - 1}`);
    }
    if (
      !Number.isInteger(spec.frameIndex) || spec.frameIndex < 0 || spec.frameIndex >= binding.frames
    ) {
      throw new Error(`Frame must be between 0 and ${binding.frames - 1}`);
    }
    const inputs = await buildCacheInputs(spec, RENDERER_VERSION);
    const key = (await sha256Hex(
      canonicalJson({ inputs, direction: spec.direction, frame: spec.frameIndex }),
    )).slice(0, 20);
    const outDir = join(spec.outDir, key);
    await fs.mkdir(outDir, { recursive: true });
    scratch = await fs.mkdtemp(join(tmpdir(), 'spritebook-look-'));
    const { prepared, warnings } = await prepareClips(spec, scratch);
    await writePoses(
      join(scratch, `poses-${binding.clipId}.bin`),
      binding.clipId,
      prepared[0].sampled,
    );
    for (const warning of warnings) yield { t: 'warn', jobId, at: at(), ...warning };
    const s = spec.style.temporal.superSample;
    for await (
      const event of runRenderJob({
        jobId: spec.jobId,
        modelPath: spec.modelPath,
        camera: {
          ...spec.camera,
          pixelsPerMeter: spec.camera.pixelsPerMeter * s,
          cellPx: { w: spec.camera.cellPx.w * s, h: spec.camera.cellPx.h * s },
          paddingPx: spec.camera.paddingPx * s,
        },
        frames: binding.frames,
        frameIndex: spec.frameIndex,
        directionSubset: [spec.direction],
        lighting: spec.style.lighting,
        pose: 'clip',
        posesPath: join(scratch, `poses-${binding.clipId}.bin`),
        stylePreset: spec.style.id,
        outDir: scratch,
      })
    ) {
      if (event.t === 'error') {
        yield event;
        return;
      }
      if (event.t === 'progress') yield event;
    }
    for (const pass of RENDER_PASSES) {
      const source = `d${String(spec.direction).padStart(2, '0')}_f${
        String(spec.frameIndex).padStart(3, '0')
      }_${pass}.png`;
      const target = join(scratch, 'frames', `d00_f000_${pass}.png`);
      if (source !== `d00_f000_${pass}.png`) {
        await fs.copyFile(join(scratch, 'frames', source), target);
      }
    }
    const result = await styleFromAovs(
      {
        framesDir: join(scratch, 'frames'),
        directions: 1,
        frames: 1,
        width: spec.camera.cellPx.w * s,
        height: spec.camera.cellPx.h * s,
      },
      spec.camera,
      spec.style,
      scratch,
    );
    const imagePath = join(outDir, 'frame.png');
    await fs.copyFile(join(result.styledDir, 'd00_f000.png'), imagePath);
    const meshKey = (await sha256Hex(
      canonicalJson({
        mesh: inputs.canonicalMeshSha256,
        clip: inputs.clipBindingHash,
        renderer: RENDERER_VERSION,
      }),
    )).slice(0, 20);
    const meshPath = join(spec.outDir, `${meshKey}.glb`);
    try {
      await fs.access(meshPath);
    } catch {
      await fs.copyFile(join(scratch, `preview-${binding.clipId}.glb`), meshPath);
    }
    const duration = prepared[0].durationS;
    await fs.writeFile(
      join(outDir, 'preview.json'),
      JSON.stringify({
        camera: spec.camera,
        style: spec.style,
        clipId: binding.clipId,
        frame: spec.frameIndex,
        direction: spec.direction,
        meshPath,
        imagePath,
        time: binding.holdLast && binding.frames > 1
          ? spec.frameIndex * duration / (binding.frames - 1)
          : spec.frameIndex * duration / binding.frames,
        duration,
        frames: binding.frames,
        flags: result.flags,
        paletteProvisional: !!spec.style.quantize,
      }),
    );
    yield {
      t: 'artifact',
      jobId,
      at: at(),
      kind: 'look-preview',
      path: join(outDir, 'preview.json'),
    };
    yield { t: 'done', jobId, at: at(), wallTimeS: (performance.now() - started) / 1000 };
  } catch (error) {
    yield {
      t: 'error',
      jobId,
      at: at(),
      code: 'look-preview-failed',
      message: String(error instanceof Error ? error.message : error),
      retryable: false,
    };
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
}
