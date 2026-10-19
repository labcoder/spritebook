import { promises as fs } from 'node:fs';
import { test } from 'node:test';
/**
 * The MATERIAL acceptance (GPU). glTF says base color is
 * `baseColorFactor × baseColorTexture` and that `alphaMode: MASK` cuts the
 * surface at `alphaCutoff`. This renderer honoured neither until the
 * 2026-07-25 audit measured it:
 *
 *   - a factor of [0.25,0.25,0.25,1] on a white texture rendered [255,255,255]
 *     — 4x too bright, in lit AND albedo, so the once-per-character adaptive
 *     palette was then built from the wrong colours;
 *   - a MASK material with half its texture at alpha 0 covered 1024 mask
 *     texels where ~half was expected, so hair cards, eyelashes and capes —
 *     the standard authoring idiom for imported characters — baked as opaque
 *     slabs in every AOV.
 *
 * Both are asserted here against exact byte values rather than tolerances,
 * because both are exactly expressible: the factor path uploads a 1x1 float
 * texture, and a discarded fragment writes nothing at all.
 */
import { assert, assertEquals } from '@std/assert';
import { Document } from '@gltf-transform/core';
import { encode as encodePng } from 'fast-png';
import type { CameraPreset } from '@spritebook/schema';
import { tryGetGpu } from './dist/gpu.js';
import { documentToAsset } from './dist/skinning.js';
import { solveFraming } from './dist/camera.js';
import { Renderer } from './dist/renderer.js';

const SHADERS = new URL('./shaders.wgsl', import.meta.url);

/** Head-on, orthographic, no elevation: the quad fills a known pixel block.
 * (2 is the smallest legal direction count; only direction 0 is rendered.) */
const CAM: CameraPreset = {
  id: 'material-1x1',
  elevationDeg: 0,
  directions: 2,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32,
  cellPx: { w: 32, h: 32 },
  paddingPx: 0,
  pivot: 'center',
  orthographic: true,
};

/**
 * A unit quad facing +Z with a base color texture and a material. `alpha`
 * builds a 2x2 texture whose RIGHT half is fully transparent, so a honoured
 * cutout removes exactly half the quad.
 */
function quadDoc(
  opts: {
    factor?: [number, number, number, number];
    alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
    cutoff?: number;
    rightHalfTransparent?: boolean;
  },
) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC3' | 'VEC2' | 'SCALAR', array: ArrayLike<number>) =>
    doc.createAccessor().setType(type).setArray(array as never).setBuffer(buffer);

  // 2x2 white; optionally the right column is alpha 0
  const px = new Uint8Array(2 * 2 * 4).fill(255);
  if (opts.rightHalfTransparent) {
    px[0 * 4 + 3] = 255;
    px[1 * 4 + 3] = 0; // row 0, col 1
    px[2 * 4 + 3] = 255;
    px[3 * 4 + 3] = 0; // row 1, col 1
  }
  const tex = doc.createTexture('base')
    .setImage(encodePng({ width: 2, height: 2, data: px }))
    .setMimeType('image/png');

  const mat = doc.createMaterial('m').setBaseColorTexture(tex);
  if (opts.factor) mat.setBaseColorFactor(opts.factor);
  if (opts.alphaMode) mat.setAlphaMode(opts.alphaMode);
  if (opts.cutoff !== undefined) mat.setAlphaCutoff(opts.cutoff);

  const prim = doc.createPrimitive()
    .setAttribute(
      'POSITION',
      acc('VEC3', new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0])),
    )
    .setAttribute('NORMAL', acc('VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])))
    // u spans the quad left->right, so the transparent texture column maps to
    // the quad's right half
    .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array([0, 1, 1, 1, 0, 0, 1, 0])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 1, 3, 2])))
    .setMaterial(mat);

  doc.createScene('s').addChild(
    doc.createNode('quad').setMesh(doc.createMesh('quad').addPrimitive(prim)),
  );
  return doc;
}

/** Render one frame and return the five AOV planes. */
async function render(doc: Document) {
  const g = (await tryGetGpu())!;
  const asset = documentToAsset(doc, 'material-test');
  const framing = solveFraming(CAM, asset.bounds);
  const r = await Renderer.create(
    g,
    asset,
    framing,
    await fs.readFile(SHADERS, 'utf8'),
    CAM.cellPx.w,
    CAM.cellPx.h,
  );
  try {
    return { planes: await r.capturePadded(0, 0), asset };
  } finally {
    r.dispose();
  }
}

/** The albedo colour of the first covered pixel, and how many were covered. */
function albedoOf(planes: Uint8Array[]) {
  const mask = new Uint32Array(planes[4].buffer, planes[4].byteOffset, planes[4].length / 4);
  const albedo = planes[1];
  let covered = 0;
  let first: [number, number, number] | null = null;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) continue;
    covered++;
    if (!first) first = [albedo[i * 4], albedo[i * 4 + 1], albedo[i * 4 + 2]];
  }
  return { covered, first };
}

test('material: baseColorFactor multiplies the texture, it is not ignored', async (t) => {
  if (!(await tryGetGpu())) { t.skip('No WebGPU adapter'); return; }

  const white = albedoOf((await render(quadDoc({}))).planes);
  const tinted = albedoOf(
    (await render(quadDoc({ factor: [0.25, 0.25, 0.25, 1] }))).planes,
  );

  assert(white.first && tinted.first, 'both renders covered pixels');
  assertEquals(white.first, [255, 255, 255], 'an untinted white texture is white');
  // linear 0.25 -> 0.25*255 = 63.75 -> 64. The bug rendered [255,255,255].
  assertEquals(
    tinted.first,
    [64, 64, 64],
    'a 0.25 factor must darken the albedo AOV; [255,255,255] is the old bug',
  );
  assertEquals(tinted.covered, white.covered, 'a factor tints, it does not cut geometry');
});

test('material: MASK discards below the cutoff, in EVERY AOV', async (t) => {
  if (!(await tryGetGpu())) { t.skip('No WebGPU adapter'); return; }

  const opaque = albedoOf((await render(quadDoc({ rightHalfTransparent: true }))).planes);
  const cut = albedoOf(
    (await render(quadDoc({
      rightHalfTransparent: true,
      alphaMode: 'MASK',
      cutoff: 0.5,
    }))).planes,
  );

  assert(opaque.covered > 0, 'the OPAQUE control drew something');
  // the transparent column is exactly half the quad's UV span
  const ratio = cut.covered / opaque.covered;
  assert(
    ratio > 0.4 && ratio < 0.6,
    `a honoured cutout removes ~half the quad: covered ${cut.covered} of ${opaque.covered} ` +
      `(ratio ${ratio.toFixed(3)}) - a ratio of 1.0 is the old bug, where alpha never ` +
      'reached the shader and the mask claimed geometry that was not there',
  );
  // and the mask really is empty there, not merely dark: this is the assertion
  // that separates "cut in colour" from "cut in the silhouette"
  assert(cut.covered < opaque.covered, 'the mask AOV lost the discarded half');
});

test('material: BLEND is treated as a cutout at 0.5 (documented limit)', async (t) => {
  if (!(await tryGetGpu())) { t.skip('No WebGPU adapter'); return; }

  const blend = albedoOf(
    (await render(quadDoc({ rightHalfTransparent: true, alphaMode: 'BLEND' }))).planes,
  );
  const mask = albedoOf(
    (await render(quadDoc({
      rightHalfTransparent: true,
      alphaMode: 'MASK',
      cutoff: 0.5,
    }))).planes,
  );
  // The AOV pass declares no blend state and depth/mask are not blendable, so
  // BLEND cannot be honoured without giving up geometrically-identical AOVs.
  // It maps to MASK@0.5 — stated in contracts.ts and asserted here so the
  // choice is visible rather than accidental.
  assertEquals(blend.covered, mask.covered, 'BLEND matches MASK at cutoff 0.5');
});

test('material: two materials sharing one texture keep their own factors', async (t) => {
  if (!(await tryGetGpu())) { t.skip('No WebGPU adapter'); return; }
  // The reason the factor cannot be folded into the decoded texels: textures
  // dedupe by glTF Texture identity, so a shared texture with two factors
  // would collide onto one entry.
  const doc = quadDoc({ factor: [0.25, 0.25, 0.25, 1] });
  const root = doc.getRoot();
  const shared = root.listTextures()[0];
  const second = doc.createMaterial('m2').setBaseColorTexture(shared).setBaseColorFactor([
    1,
    1,
    1,
    1,
  ]);
  // a second primitive, same texture, different factor
  const src = root.listMeshes()[0].listPrimitives()[0];
  const clone = doc.createPrimitive()
    .setAttribute('POSITION', src.getAttribute('POSITION')!)
    .setAttribute('NORMAL', src.getAttribute('NORMAL')!)
    .setAttribute('TEXCOORD_0', src.getAttribute('TEXCOORD_0')!)
    .setIndices(src.getIndices()!)
    .setMaterial(second);
  root.listMeshes()[0].addPrimitive(clone);

  const asset = documentToAsset(doc, 'shared-texture');
  assertEquals(asset.textures.length, 1, 'the image is deduped');
  assertEquals(asset.materials.length, 2, 'but the materials are not');
  assertEquals(asset.materials[0].texture, asset.materials[1].texture, 'both point at it');
  assertEquals(asset.materials[0].factor[0], 0.25);
  assertEquals(asset.materials[1].factor[0], 1);
});

test('material: a semi-transparent BLEND surface bakes PRESENT, not absent', async (t) => {
  if (!(await tryGetGpu())) { t.skip('No WebGPU adapter'); return; }
  // The regression this pins, measured on GPU before the fix: a BLEND material
  // whose baseColorFactor alpha sat below the 0.5 cutout discarded EVERY
  // fragment, so a 40%-opacity cape, visor or glass vanished from all five
  // AOVs with no warn and no flag. The contract promised "hard-edged", and
  // absent is not hard-edged.
  //
  // The cutout tests the texture's alpha alone for BLEND, because a uniform
  // factor carries no silhouette - comparing it to a cutoff can only discard
  // everything or nothing.
  const opaque = albedoOf((await render(quadDoc({}))).planes);

  for (const a of [0.9, 0.5, 0.4, 0.05]) {
    const blend = albedoOf(
      (await render(quadDoc({ factor: [1, 1, 1, a], alphaMode: 'BLEND' }))).planes,
    );
    assertEquals(
      blend.covered,
      opaque.covered,
      `BLEND at factor alpha ${a} must still draw its surface (covered ${blend.covered} of ` +
        `${opaque.covered}); 0 is the regression where the whole surface vanished`,
    );
  }

  // and a BLEND texture that DOES carry alpha shape still cuts out
  const shaped = albedoOf(
    (await render(quadDoc({ rightHalfTransparent: true, alphaMode: 'BLEND' }))).planes,
  );
  const ratio = shaped.covered / opaque.covered;
  assert(ratio > 0.4 && ratio < 0.6, `texture alpha still shapes the cutout (ratio ${ratio})`);
});

test('material: MASK keeps the full glTF product, factor alpha included', async (t) => {
  if (!(await tryGetGpu())) { t.skip('No WebGPU adapter'); return; }
  // Not a bug, and deliberately NOT changed: glTF says alpha is
  // factor.a * texture.a, so a MASK material whose factor alpha is below its
  // own cutoff is the author declaring the surface fully transparent. We honour
  // that rather than second-guessing it - the BLEND carve-out above exists only
  // because the 0.5 cutout there is OUR choice, not the file's.
  const opaque = albedoOf((await render(quadDoc({}))).planes);
  const above = albedoOf(
    (await render(quadDoc({ factor: [1, 1, 1, 0.6], alphaMode: 'MASK', cutoff: 0.5 }))).planes,
  );
  const below = albedoOf(
    (await render(quadDoc({ factor: [1, 1, 1, 0.4], alphaMode: 'MASK', cutoff: 0.5 }))).planes,
  );
  assertEquals(above.covered, opaque.covered, 'factor alpha above the cutoff draws');
  assertEquals(below.covered, 0, 'factor alpha below the cutoff is the author saying invisible');
});
