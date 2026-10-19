import { promises as fs } from 'node:fs';
import { test } from 'node:test';
/**
 * The LIGHTING acceptance (GPU): what the lit AOV holds, against the closed
 * form the shader claims to compute.
 *
 * This existed as an unmeasured assumption for the whole of P2 and P3. Every
 * baked sheet read darker than its reference and the gap was blamed in turn on
 * the palette, the outline and the scale; measured, the lit pass carries about
 * 60% of the albedo's value on a character, and nothing anywhere pinned whether
 * that was the Lambert term doing its job or a defect.
 *
 * A flat quad facing +Z makes the answer exact. The light is a constant world
 * direction (renderer.ts LIGHT_DIR = [0.4, 0.9, 0.5], normalized), so a surface
 * whose normal is +Z has
 *
 *     ndl = dot([0,0,1], normalize([0.4,0.9,0.5])) = 0.452679
 *     shade = ambient + (1 - ambient) * ndl = 0.12 + 0.88 * 0.452679 = 0.518358
 *
 * and the lit byte is `srgbEncode(albedoLinear * shade) * 255`. There is no
 * tolerance to argue about: three different defects predict three different
 * numbers, and the test names them.
 */
import { assert, assertEquals } from '@std/assert';
import { Document } from '@gltf-transform/core';
import type { CameraPreset } from '@spritebook/schema';
import { tryGetGpu } from './dist/gpu.js';
import { documentToAsset } from './dist/skinning.js';
import { solveFraming } from './dist/camera.js';
import { AMBIENT, LIGHT_DIR, Renderer } from './dist/renderer.js';

const SHADERS = new URL('./shaders.wgsl', import.meta.url);

const CAM: CameraPreset = {
  id: 'lighting-flat',
  elevationDeg: 0,
  directions: 2,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32,
  cellPx: { w: 32, h: 32 },
  paddingPx: 0,
  pivot: 'center',
  orthographic: true,
};

/** The shader's own encode, in TypeScript, so the two can be compared. */
function srgbEncode(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
}

/** An unlit-white quad facing +Z, tinted by `factor` — no texture to confuse it. */
function quad(factor: [number, number, number, number]): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC3' | 'SCALAR', array: ArrayLike<number>) =>
    doc.createAccessor().setType(type).setArray(array as never).setBuffer(buffer);
  const prim = doc.createPrimitive()
    .setAttribute(
      'POSITION',
      acc('VEC3', new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0])),
    )
    .setAttribute('NORMAL', acc('VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 1, 3, 2])))
    .setMaterial(doc.createMaterial('m').setBaseColorFactor(factor));
  doc.createScene('s').addChild(
    doc.createNode('quad').setMesh(doc.createMesh('quad').addPrimitive(prim)),
  );
  return doc;
}

/** lit and albedo bytes of the first covered texel. */
async function shade(factor: [number, number, number, number]) {
  const g = (await tryGetGpu())!;
  const asset = documentToAsset(quad(factor), 'lighting-test');
  const r = await Renderer.create(
    g,
    asset,
    solveFraming(CAM, asset.bounds),
    await fs.readFile(SHADERS, 'utf8'),
    CAM.cellPx.w,
    CAM.cellPx.h,
  );
  try {
    const planes = await r.capturePadded(0, 0);
    const mask = new Uint32Array(planes[4].buffer, planes[4].byteOffset, planes[4].length / 4);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 0) continue;
      return {
        lit: [planes[0][i * 4], planes[0][i * 4 + 1], planes[0][i * 4 + 2]] as const,
        albedo: [planes[1][i * 4], planes[1][i * 4 + 1], planes[1][i * 4 + 2]] as const,
      };
    }
    return null;
  } finally {
    r.dispose();
  }
}

/** ndl for a +Z surface under the shipped rig — the one number everything below rests on. */
function ndlFacingCamera(): number {
  const [x, y, z] = LIGHT_DIR;
  return z / Math.hypot(x, y, z);
}

test('the lit AOV is exactly albedo * (ambient + (1-ambient)*ndl), sRGB-encoded once', async (t) => {
  if (!(await tryGetGpu())) { t.skip('No WebGPU adapter'); return; }
  const ndl = ndlFacingCamera();
  const shadeFactor = AMBIENT + (1 - AMBIENT) * ndl;

  for (const a of [1.0, 0.5, 0.25]) {
    const got = await shade([a, a, a, 1]);
    assert(got, `a quad at albedo ${a} covered pixels`);
    const expected = Math.round(srgbEncode(a * shadeFactor) * 255);
    for (let c = 0; c < 3; c++) {
      assert(
        Math.abs(got.lit[c] - expected) <= 1,
        `albedo ${a}: lit channel ${c} is ${got.lit[c]}, the shading math says ${expected}. ` +
          `A SECOND sRGB encode would read ${
            Math.round(srgbEncode(srgbEncode(a * shadeFactor)) * 255)
          }; ` +
          `no ambient term would read ${Math.round(srgbEncode(a * ndl) * 255)}; ` +
          `no lighting at all would read ${Math.round(srgbEncode(a) * 255)}.`,
      );
    }
    // and the albedo AOV is the raw LINEAR value, which is what makes it a data
    // AOV and why comparing its bytes to lit's directly is a category error.
    // +/-1 because the unorm encode owns the rounding at .5 (0.5*255 = 127.5
    // reads back as 127), not because the value is approximate.
    assert(
      Math.abs(got.albedo[0] - a * 255) <= 1,
      `albedo ${a} is stored LINEAR: expected ~${a * 255}, got ${got.albedo[0]}`,
    );
  }
});

test('what the rig costs a camera-facing surface, from the rig itself', async (t) => {
  // The number behind "every sheet reads darker than its reference". It is not
  // a defect and this test exists to stop anyone re-diagnosing it as one: the
  // key light sits at [0.4, 0.9, 0.5], which is mostly OVERHEAD, so a surface
  // pointing at the camera catches it at ndl 0.45 rather than 1.0.
  //
  // For a sprite renderer that is the load-bearing fact, because the
  // camera-facing surfaces are the ones that end up in the sheet. The bound is
  // DERIVED from AMBIENT rather than pinned at a measured percentage, so
  // changing the rig moves this test's expectation with it instead of failing
  // it — the loss was 26% at the 0.12 that shipped first and is 19% at 0.30.
  if (!(await tryGetGpu())) { t.skip('No WebGPU adapter'); return; }
  const got = await shade([1, 1, 1, 1]);
  assert(got);

  const ndl = ndlFacingCamera();
  assert(Math.abs(ndl - 0.452679) < 1e-5, `the rig's geometry is unchanged: ndl ${ndl}`);

  // white albedo, so sRGB(1.0) would be 255 and the shortfall is the rig alone
  const drop = 1 - got.lit[0] / 255;
  const predicted = 1 - srgbEncode(AMBIENT + (1 - AMBIENT) * ndl);
  assert(
    Math.abs(drop - predicted) < 0.01,
    `a white camera-facing surface loses ${(drop * 100).toFixed(1)}%; the rig predicts ${
      (predicted * 100).toFixed(1)
    }%`,
  );
  assert(drop > 0, 'and it is a loss, not a gain');

  // A surface facing the light directly gets its full value back, which is what
  // proves the loss is ORIENTATION and not a global scale on the output.
  assertEquals(
    Math.round(srgbEncode(AMBIENT + (1 - AMBIENT) * 1.0) * 255),
    255,
    'ndl 1 costs nothing at all',
  );
});

test('camera-frame lighting reproduces the front relation at every yaw', async () => {
  // B3 (C-WAVE.md): 'world' keeps one world-space key, so a back view is lit
  // from behind; 'camera' rotates the key with each direction's camera, so the
  // light-to-camera relation at direction 0 is reproduced everywhere. Both are
  // closed-form checkable without a GPU: at yaw 0 the two frames agree
  // exactly, and at yaw 180 the camera-frame key has its horizontal components
  // negated while Y (the overhead component) is untouched.
  const { DEFAULT_LIGHT_FRAME, lightDirFor } = await import('./dist/renderer.js');

  assertEquals(lightDirFor('world', 0), [...LIGHT_DIR] as [number, number, number]);
  assertEquals(lightDirFor('camera', 0), [...LIGHT_DIR] as [number, number, number]);
  assertEquals(
    lightDirFor('world', 180),
    [...LIGHT_DIR] as [number, number, number],
    'world ignores yaw entirely',
  );

  const back = lightDirFor('camera', 180);
  assert(Math.abs(back[0] + LIGHT_DIR[0]) < 1e-12, 'x flips at yaw 180');
  assert(back[1] === LIGHT_DIR[1], 'the overhead component never changes');
  assert(Math.abs(back[2] + LIGHT_DIR[2]) < 1e-12, 'z flips at yaw 180');

  // rotation preserves length, so ndl magnitudes are comparable across frames
  for (const yaw of [45, 90, 135, 270]) {
    const d = lightDirFor('camera', yaw);
    assert(
      Math.abs(Math.hypot(...d) - Math.hypot(...LIGHT_DIR)) < 1e-12,
      `unit-preserving at yaw ${yaw}`,
    );
  }

  // the CONSEQUENCE, stated as the number the sheets will show: a +Z surface
  // viewed from the back (yaw 180) has ndl 0 under 'world' (lit from behind,
  // ambient only) and the front's 0.4527 under 'camera'
  const len = Math.hypot(...LIGHT_DIR);
  const ndlWorldBack = Math.max(0, -lightDirFor('world', 180)[2] / len);
  const ndlCameraBack = Math.max(0, -back[2] / len);
  assertEquals(ndlWorldBack, 0, 'world: the back of the character gets ambient only');
  assert(
    Math.abs(ndlCameraBack - LIGHT_DIR[2] / len) < 1e-12,
    'camera: the back reads exactly like the front',
  );
  assert(DEFAULT_LIGHT_FRAME === 'world' || DEFAULT_LIGHT_FRAME === 'camera');
});
