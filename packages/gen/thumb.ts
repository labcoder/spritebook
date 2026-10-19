import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Front-view thumbnail per generation result (W5b). The candidates screen
 * judged meshes by NUMBERS — seed, tris, seconds — and choosing between two
 * interpretations meant flipping Inspect from memory. A thumbnail is CORE
 * output (the GUI never renders truth): one 192px lit frame through the same
 * headless pipeline the bake uses, so what the card shows is what the
 * renderer sees.
 *
 * Best-effort by DESIGN: no adapter (CPU-only CI) or any render failure
 * means no thumb and nothing else — a missing picture must never fail a
 * generation that succeeded. The pixels-per-metre adapts to the measured
 * height, so an unscaled unit-box candidate still FILLS its thumbnail; the
 * card is for judging the mesh, the scale-undeclared warn is for judging
 * the scale.
 */

const THUMB_PX = 192;
const THUMB_PAD = 12;

export type ThumbOutcome = 'written' | 'skipped-no-gpu' | 'failed';

export async function writeResultThumb(
  modelPath: string,
  heightM: number,
  outPath: string,
): Promise<ThumbOutcome> {
  // dynamic: gen must not pull WebGPU into every run that never thumbnails
  const render = await import('@spritebook/render');
  if ((await render.tryGetGpu()) === null) return 'skipped-no-gpu';
  const camera = {
    id: 'thumb-front',
    elevationDeg: 20,
    directions: 8 as const,
    yawOffsetDeg: 0,
    pixelsPerMeter: (THUMB_PX - 2 * THUMB_PAD) / Math.max(heightM, 1e-6),
    cellPx: { w: THUMB_PX, h: THUMB_PX },
    paddingPx: THUMB_PAD,
    pivot: 'feet-baseline' as const,
    orthographic: true as const,
  };
  const tmp = await fs.mkdtemp(join(tmpdir(), 'sb-thumb-'));
  try {
    for await (
      const e of render.runRenderJob({
        jobId: 'thumb',
        modelPath,
        camera,
        frames: 1,
        directionSubset: [0],
        stylePreset: 'thumb', // carried through as a label; unused by the pass
        outDir: tmp,
      })
    ) {
      if (e.t === 'error') return 'failed';
    }
    await fs.copyFile(`${tmp}/frames/d00_f000_lit.png`, outPath);
    return 'written';
  } catch {
    return 'failed';
  } finally {
    await fs.rm(tmp, { recursive: true }).catch(() => {});
  }
}
