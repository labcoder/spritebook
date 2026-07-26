/**
 * P3-T1 end-to-end acceptance on a REAL GPU bake (gated like the other seams):
 * a UAL walk retargeted onto a proportioned fixture body, sampled per binding,
 * rendered pose 'clip', styled, packed —
 *   - sampled frame count matches clips x directions x frames EXACTLY;
 *   - every FrameRecord carries its clipId;
 *   - the retarget-once preview GLB is a bake artifact;
 *   - a second clip in the same bake shares one palette (per-character law).
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import { PIXEL_8 } from '@spritebook/style';
import { tryGetGpu } from '../render/gpu.ts';
import { runBakeJob } from '@spritebook/pack';
import type { CameraPreset, JobEvent } from '@spritebook/schema';

const win = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MODEL = win(new URL('./fixtures/humanoid-normal.glb', import.meta.url));
const CAM: CameraPreset = {
  id: 'anim-itest-30x2',
  elevationDeg: 30,
  directions: 2,
  yawOffsetDeg: 0,
  pixelsPerMeter: 24,
  cellPx: { w: 64, h: 64 },
  paddingPx: 6,
  pivot: 'feet-baseline',
  orthographic: true,
};

Deno.test('acceptance: multi-clip bake — exact counts, clip ids, previews', async () => {
  if (!(await tryGetGpu())) return;
  const root = await Deno.makeTempDir();
  try {
    const events: JobEvent[] = [];
    for await (
      const e of runBakeJob({
        jobId: 'anim-itest',
        characterId: 'walker',
        modelPath: MODEL,
        camera: CAM,
        style: PIXEL_8,
        frames: 4, // legacy field; clips below own their frame counts
        outRoot: root,
        clips: [
          { clipId: 'walk-loop', frames: 4, speed: 1, holdLast: false },
          { clipId: 'idle-loop', frames: 2, speed: 1, holdLast: false },
        ],
      })
    ) events.push(e);
    const err = events.find((e) => e.t === 'error');
    assert(!err, `bake failed: ${JSON.stringify(err)}`);
    // the fixture implements the full 21-joint core and its feet plant within
    // tolerance — a warn here means the retarget evidence path regressed
    const warns = events.filter((e) => e.t === 'warn');
    assertEquals(warns, [], 'clean fixture bakes without retarget warnings');

    const manifestPath = (events.find((e) => e.t === 'artifact' && e.kind === 'bake-manifest') as {
      path: string;
    }).path;
    const bakeDir = manifestPath.slice(0, manifestPath.lastIndexOf('/'));
    const manifest = parseWith(
      BakeManifestSchema,
      JSON.parse(await Deno.readTextFile(manifestPath)),
      'BakeManifest',
    );

    // sampled count matches clips x directions x frames EXACTLY
    assertEquals(manifest.frames.length, 2 * 4 + 2 * 2, 'sum over clips of dirs*frames');
    assertEquals(manifest.metrics.framesTotal, 12);
    const byClip = new Map<string, number>();
    for (const f of manifest.frames) byClip.set(f.clipId, (byClip.get(f.clipId) ?? 0) + 1);
    assertEquals(byClip.get('walk-loop'), 8);
    assertEquals(byClip.get('idle-loop'), 4);

    // Per-clip timing an exporter can act on. Before this existed the bindings
    // reached the manifest only as a sha256, so Godot hardcoded loop:true for
    // every clip and one --fps was applied to clips of different lengths.
    const timings = manifest.clips;
    assert(timings, 'a clip bake records its clip timing');
    assertEquals(timings.length, 2, 'one entry per bound clip');
    const walk = timings.find((c) => c.clipId === 'walk-loop')!;
    const idle = timings.find((c) => c.clipId === 'idle-loop')!;
    assertEquals(walk.frames, 4);
    assertEquals(idle.frames, 2);
    assertEquals(walk.holdLast, false);
    assertEquals(walk.loop, true, 'loop is the inverse of holdLast');
    // the two clips have different lengths, so a single exported fps is a lie
    assert(
      walk.fps !== idle.fps,
      `clips of different lengths must not share an fps: ${walk.fps} vs ${idle.fps}`,
    );
    for (const c of timings) assert(c.fps > 0 && Number.isFinite(c.fps), `real fps: ${c.fps}`);

    // retarget-once artifacts: one preview GLB per clip
    await Deno.stat(`${bakeDir}/preview-walk-loop.glb`);
    await Deno.stat(`${bakeDir}/preview-idle-loop.glb`);
    // per-clip contact sheets
    await Deno.stat(`${bakeDir}/contact-walk-loop.gif`);
    await Deno.stat(`${bakeDir}/contact-idle-loop.gif`);

    // one palette across BOTH clips (the per-character palette law)
    const styleResult = JSON.parse(await Deno.readTextFile(`${bakeDir}/style-result.json`));
    assert(styleResult.paletteHex.length <= 8 && styleResult.paletteHex.length > 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
