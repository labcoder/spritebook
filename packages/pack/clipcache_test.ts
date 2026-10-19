import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Clip CONTENT is a cache input (review F1): editing a pack clip glb in place
 * (the documented pack-upgrade flow) must invalidate — the binding spec alone
 * would serve stale atlas pixels while the preview GLB regenerates from the
 * new bytes, an internally inconsistent bake dir (D-006). CPU-only: this pins
 * the key inputs; the GPU acceptance suite covers served-vs-recomputed parity.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { CameraPreset } from '@spritebook/schema';
import { PIXEL } from '@spritebook/style';
import { buildCacheInputs } from './dist/bake.js';

const MODEL = new URL('../anim/fixtures/humanoid-normal.glb', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const CAM: CameraPreset = {
  id: 'clipcache-30x2',
  elevationDeg: 30,
  directions: 2,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32,
  cellPx: { w: 64, h: 64 },
  paddingPx: 6,
  pivot: 'feet-baseline',
  orthographic: true,
};
const SIG = 'test-signature';

async function makePack(dir: string, clipBytes: Uint8Array): Promise<void> {
  await fs.mkdir(`${dir}/clips`, { recursive: true });
  await fs.writeFile(`${dir}/clips/x.glb`, clipBytes);
}

function spec(packDir: string, over: Record<string, unknown> = {}) {
  return {
    characterId: 'c',
    modelPath: MODEL,
    camera: CAM,
    style: PIXEL,
    frames: 2,
    clips: [{ clipId: 'x', frames: 2, speed: 1, holdLast: false }],
    packDir,
    ...over,
  };
}

test('clip bytes are a cache input; paths are not; bindings still are', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    await makePack(`${root}/p1`, bytes);
    const base = await buildCacheInputs(spec(`${root}/p1`), SIG);

    // in-place content edit -> different recipe
    await fs.writeFile(`${root}/p1/clips/x.glb`, Uint8Array.from([1, 2, 3, 4, 5, 6]));
    const edited = await buildCacheInputs(spec(`${root}/p1`), SIG);
    assert(
      edited.clipBindingHash !== base.clipBindingHash,
      'editing clip bytes in place must change the bake recipe',
    );

    // same bytes under a different pack path -> SAME recipe (content-addressed)
    await makePack(`${root}/p2`, bytes);
    const moved = await buildCacheInputs(spec(`${root}/p2`), SIG);
    assertEquals(moved.clipBindingHash, base.clipBindingHash, 'content-addressed, not path-keyed');

    // binding change (speed) -> different recipe, same content
    const faster = await buildCacheInputs(
      spec(`${root}/p2`, { clips: [{ clipId: 'x', frames: 2, speed: 2, holdLast: false }] }),
      SIG,
    );
    assert(faster.clipBindingHash !== base.clipBindingHash, 'binding fields still hash');

    // legacy no-clips path never touches the pack (P2 cache compat)
    const legacy = await buildCacheInputs(
      spec(`${root}/does-not-exist`, { clips: undefined }),
      SIG,
    );
    assert(legacy.clipBindingHash !== base.clipBindingHash);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('missing clip file fails actionably, naming clip and path', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await fs.mkdir(`${root}/empty/clips`, { recursive: true });
    const err = await assertRejects(
      () => buildCacheInputs(spec(`${root}/empty`), SIG),
      Error,
      'Cannot read clip "x"',
    );
    assert(err.message.includes('x.glb'), 'error names the resolved path');
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
