import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { CacheKeyInputs } from '@spritebook/schema';
import { assembleManifest, frameGrid } from './manifest.ts';
import { bakeKey, frameKey } from './cache.ts';
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

Deno.test('frameGrid: deterministic direction-major order', () => {
  const g = frameGrid(2, 2);
  assertEquals(g.map(frameIdKey), [
    'idle/d00/f000',
    'idle/d00/f001',
    'idle/d01/f000',
    'idle/d01/f001',
  ]);
});
