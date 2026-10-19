import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * P3-T1 end-to-end acceptance on a REAL GPU bake (gated like the other seams):
 * a UAL walk retargeted onto a proportioned fixture body, sampled per binding,
 * rendered pose 'clip', styled, packed —
 *   - sampled frame count matches clips x directions x frames EXACTLY;
 *   - every FrameRecord carries its clipId;
 *   - the retarget-once preview GLB is a bake artifact;
 *   - a second clip in the same bake shares one palette (per-character law).
 */
import { assert, assertEquals } from '@std/assert';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import { PIXEL } from '@spritebook/style';
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

test('acceptance: multi-clip bake — exact counts, clip ids, previews', async () => {
  if (!(await tryGetGpu())) return;
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const events: JobEvent[] = [];
    for await (
      const e of runBakeJob({
        jobId: 'anim-itest',
        characterId: 'walker',
        modelPath: MODEL,
        camera: CAM,
        style: PIXEL,
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
    const retargetWarns = warns.filter((w) =>
      w.code === 'anim-unmapped-core' || w.code === 'anim-foot-contact'
    );
    assertEquals(retargetWarns, [], 'clean fixture bakes without retarget warnings');

    // This assertion used to be `warns === []`, which was really a claim about
    // the retarget path (see the comment above) but happened to also assert
    // that NOTHING else ever warns. The silhouette-clipped detector then
    // revealed a genuine property of this fixture: at 24 px/m in a 64px cell
    // with feet-baseline putting the baseline at row 58, the walk cycle swings
    // a foot below the grounded plane and reaches the bottom border (4px) on 3
    // of the 12 frames. That is real and worth flagging, so it is asserted
    // rather than silenced - if the fixture or the framing ever changes so the
    // character fits, this is the line that says so.
    const clip = warns.find((w) => w.code === 'silhouette-clipped');
    assert(
      clip,
      `the tight fixture reports its clipping; got ${JSON.stringify(warns.map((w) => w.code))}`,
    );
    assert(/bottom/.test(clip.message), `and names the edge: ${clip.message}`);

    const manifestPath = (events.find((e) => e.t === 'artifact' && e.kind === 'bake-manifest') as {
      path: string;
    }).path;
    const bakeDir = manifestPath.slice(0, manifestPath.lastIndexOf('/'));
    const manifest = parseWith(
      BakeManifestSchema,
      JSON.parse(await fs.readFile(manifestPath, 'utf8')),
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
    await fs.stat(`${bakeDir}/preview-walk-loop.glb`);
    await fs.stat(`${bakeDir}/preview-idle-loop.glb`);
    // per-clip contact sheets
    await fs.stat(`${bakeDir}/contact-walk-loop.gif`);
    await fs.stat(`${bakeDir}/contact-idle-loop.gif`);

    // one palette across BOTH clips (the per-character palette law). Bounded by
    // the PRESET's own budget, not a literal: this said `<= 8` and was really
    // asserting what pixel's maxColors happened to be, so raising it to 16 broke
    // a test that has nothing to do with palette size.
    const styleResult = JSON.parse(await fs.readFile(`${bakeDir}/style-result.json`, 'utf8'));
    assert(
      styleResult.paletteHex.length <= PIXEL.quantize!.maxColors &&
        styleResult.paletteHex.length > 0,
      `one pooled palette within budget, got ${styleResult.paletteHex.length}`,
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
