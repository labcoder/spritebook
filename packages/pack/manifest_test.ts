import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { CacheKeyInputs } from '@spritebook/schema';
import { assembleManifest, frameGrid } from './manifest.ts';
import { bakeKey, frameKey } from './cache.ts';
import { mirrorPlan } from './mirror.ts';
import { frameIdKey, type PackLayout } from './contracts.ts';

const INPUTS: CacheKeyInputs = {
  characterId: 'test-char',
  canonicalMeshSha256: 'a'.repeat(64),
  rigStateHash: 'b'.repeat(64),
  clipBindingHash: 'c'.repeat(64),
  cameraPresetHash: 'd'.repeat(64),
  stylePresetHash: 'e'.repeat(64),
  rendererVersion: 'spritebook-render@0.1.0',
  backend: { modelId: 'source-mesh', version: '0', paramsHash: 'f'.repeat(64) },
} as CacheKeyInputs;

function layoutOf(ids = frameGrid(2, 2), cell = 16): PackLayout {
  return {
    pageCount: 1,
    pageSizePx: 64,
    rects: ids.map((id, i) => ({ id, pageIndex: 0, x: i * cell, y: 0, w: cell, h: cell })),
  };
}

Deno.test('assembleManifest: bakeId is the recipe-key prefix; folds style + cache state', async () => {
  const layout = layoutOf();
  const hits = new Set([frameIdKey(layout.rects[0].id), frameIdKey(layout.rects[1].id)]);
  const m = await assembleManifest({
    inputs: INPUTS,
    layout,
    pivotPx: { x: 8, y: 14 },
    cacheHits: hits,
    styleResult: {
      flickerPct: 0.42,
      flags: [{
        code: 'outline-exceeds-padding',
        severity: 'warn',
        sourceStage: 'look',
        frameRefs: [{ clipId: 'idle', direction: 0, frame: 0 }],
        message: 'test flag',
      }],
    },
    wallTimeS: 1.25,
    now: () => '2026-07-15T00:00:00.000Z',
  });

  assertEquals(m.bakeId, (await bakeKey(INPUTS)).slice(0, 8), 'bakeId = 8-hex recipe prefix');
  assertEquals(m.characterId, 'test-char');
  assertEquals(m.frames.length, 4);
  assertEquals(m.frames[1].atlas, { pageIndex: 0, x: 16, y: 0, w: 16, h: 16 });
  assertEquals(m.frames.map((f) => f.cacheHit), [true, true, false, false]);
  assertEquals(m.metrics.cacheHitPct, 50);
  assertEquals(m.metrics.flickerPct, 0.42);
  assertEquals(m.metrics.framesTotal, 4);
  assertEquals(m.flags.length, 1);
  // 5 passes x 1 page, every AOV page shares the lit layout (the law, recorded)
  assertEquals(m.atlases.length, 5);
  assert(m.atlases.every((a) => a.layoutSharedWith === 'lit' && a.sizePx === 64));
  assertEquals(m.atlases.map((a) => a.png).sort()[0], 'atlas_albedo_0.png');
});

Deno.test('unchanged recipe reproduces the same bakeId; frame keys stay stable', async () => {
  const a = await assembleManifest({
    inputs: INPUTS,
    layout: layoutOf(),
    pivotPx: { x: 8, y: 14 },
    cacheHits: new Set(),
    styleResult: { flickerPct: 0, flags: [] },
    wallTimeS: 9.9, // volatile — must not affect identity
    now: () => '2027-01-01T00:00:00.000Z',
  });
  const b = await assembleManifest({
    inputs: INPUTS,
    layout: layoutOf(),
    pivotPx: { x: 8, y: 14 },
    cacheHits: new Set(),
    styleResult: { flickerPct: 0, flags: [] },
    wallTimeS: 0.1,
    now: () => '2026-07-15T00:00:00.000Z',
  });
  assertEquals(a.bakeId, b.bakeId, 'identity follows the recipe, not the clock');
  const key = await bakeKey(INPUTS);
  assertEquals(
    await frameKey(key, { clipId: 'idle', direction: 0, frame: 0 }),
    await frameKey(key, { clipId: 'idle', direction: 0, frame: 0 }),
  );
});

/** One page, one frame per direction, every cell `w` wide. */
function cellLayout(directions: number, w: number): PackLayout {
  return {
    pageCount: 1,
    pageSizePx: 1024,
    rects: frameGrid(directions, 1).map((id, i) => ({
      id,
      pageIndex: 0,
      x: i * w,
      y: 0,
      w,
      h: w,
    })),
  };
}

Deno.test('D-008: a mirrored frame records the MIRRORED pivot x, y untouched', async () => {
  // A mirrored cell is a horizontal flip, so its pivot flips with it. This went
  // unnoticed because every in-repo preset is feet-baseline/center on an even
  // cell, where the pivot is Math.round(w/2) and `w - x == x` — the bug is
  // arithmetically INVISIBLE on every preset the suite has ever baked. A 25% x
  // is schema-legal ({xPct, yPct}, schema/project.ts) and is where it shows.
  const w = 64;
  const plan = mirrorPlan(8, true); // renders 0-4, mirrors 5<-3, 6<-2, 7<-1
  const m = await assembleManifest({
    inputs: INPUTS,
    layout: cellLayout(8, w),
    pivotPx: { x: 16, y: 58 }, // {xPct: 25, yPct: ~90} of a 64px cell
    cacheHits: new Set(),
    mirroredFrom: plan.mirroredFrom,
    styleResult: { flickerPct: 0, flags: [] },
    wallTimeS: 0,
    now: () => '2026-07-25T00:00:00.000Z',
  });

  const byDir = new Map(m.frames.map((f) => [f.direction, f]));
  assertEquals([...plan.mirroredFrom.keys()].sort(), [5, 6, 7], 'the rule under test');
  for (const d of plan.rendered) {
    assertEquals(
      byDir.get(d)!.pivotPx,
      { x: 16, y: 58 },
      `direction ${d} was rendered, not flipped`,
    );
  }
  for (const d of plan.mirroredFrom.keys()) {
    // 64 - 16 = 48. The pixel flip is `w-1-x` (mirror.ts) because that is INDEX
    // space; pivotPx is an EDGE coordinate on [0, w] (render/camera.ts:9-12),
    // where the same map is `u -> w - u`. `w-1-x` would record 47 here.
    assertEquals(
      byDir.get(d)!.pivotPx,
      { x: 48, y: 58 },
      `direction ${d} is a flip of ${plan.mirroredFrom.get(d)}`,
    );
  }
});

Deno.test('the mirrored pivot fixes a centred pivot and survives an odd cell', async () => {
  const cases: Array<[number, number, number, string]> = [
    // [cell w, pivot x, mirrored x, why this case earns its place]
    [64, 32, 32, 'a centred pivot is its own mirror; w-1-x would give 31'],
    [64, 16, 48, 'a 25% pivot mirrors to 75%'],
    [64, 0, 64, 'the left edge mirrors to the right edge, not to texel 63'],
    // Math.round snaps an odd centre off by half a texel (65 -> 33), so w-x is
    // 32: the correct mirror of the SNAPPED pivot, not of the true centre. The
    // asymmetry is inherent to edge-snapping an odd width, not a bug here.
    [65, 33, 32, 'odd w mirrors the snapped pivot'],
  ];
  for (const [w, x, want, why] of cases) {
    const m = await assembleManifest({
      inputs: INPUTS,
      layout: cellLayout(8, w),
      pivotPx: { x, y: 7 },
      cacheHits: new Set(),
      mirroredFrom: mirrorPlan(8, true).mirroredFrom,
      styleResult: { flickerPct: 0, flags: [] },
      wallTimeS: 0,
      now: () => '2026-07-25T00:00:00.000Z',
    });
    const mirrored = m.frames.find((f) => f.direction === 7)!;
    assertEquals(mirrored.pivotPx, { x: want, y: 7 }, `w=${w} x=${x}: ${why}`);
    assertEquals(
      m.frames.find((f) => f.direction === 0)!.pivotPx,
      { x, y: 7 },
      'rendered untouched',
    );
  }
});

Deno.test('mirroring off: every frame keeps the pivot it was framed with', async () => {
  const m = await assembleManifest({
    inputs: INPUTS,
    layout: cellLayout(8, 64),
    pivotPx: { x: 16, y: 58 },
    cacheHits: new Set(),
    mirroredFrom: mirrorPlan(8, false).mirroredFrom, // empty
    styleResult: { flickerPct: 0, flags: [] },
    wallTimeS: 0,
    now: () => '2026-07-25T00:00:00.000Z',
  });
  assert(m.frames.every((f) => f.pivotPx.x === 16 && f.pivotPx.y === 58));
  assert(m.frames.every((f) => f.mirroredFrom === undefined), 'and no frame claims a source');
});

Deno.test('frameGrid: deterministic direction-major order', () => {
  const g = frameGrid(2, 2);
  assertEquals(g.map(frameIdKey), [
    'idle/d00/f000',
    'idle/d00/f001',
    'idle/d01/f000',
    'idle/d01/f001',
  ]);
});
