/**
 * THE ATTACHMENT ACCEPTANCE: a sword hung on the `hand-r` socket must bake IN
 * THE HAND, in every direction, and stay there while a clip swings the arm.
 *
 * Before the loader honoured node transforms a socketed prop rode joint 0 and
 * baked at the model ORIGIN — correct in any exporter, wrong in our own sprite
 * sheets. That is the bug this pins, so the negative control (assertion 4) is
 * the load-bearing half: it is the assertion that fails if the regression ever
 * comes back.
 *
 * ## Why this drives the Renderer directly instead of runBakeJob
 *
 * Adding a sword changes the model's bounds, so `feet-baseline` re-solves the
 * footprint centre and the WHOLE silhouette shifts a little between an
 * un-attached and an attached bake. A naive A/B pixel diff would therefore
 * light up every edge in the image and tell us nothing about the prop. Reading
 * raw AOV planes gives a framing we control and, crucially, the view/proj we
 * need to project the hand joint ourselves.
 *
 * ## Ground truth is the JOINT, never the prop
 *
 * `hand_r`'s world position comes out of `worlds` (composed from bind locals +
 * the poses blob), which is computed with no reference whatsoever to the
 * prop's vertices. If the test derived the expected position from the prop it
 * would only be re-deriving the shader and could never fail. The projector is
 * itself self-checked against `framing.pivotPx` before any of it is trusted.
 *
 * The prop is magenta via `baseColorFactor` with no texture, so it lands in the
 * albedo AOV as exactly (255, 0, 255, 255): albedo is written linear and
 * untextured factors now upload as exact float, so this is a bit pattern rather
 * than a tolerance.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1';
import { NodeIO } from '@gltf-transform/core';
import type { CameraPreset } from '@spritebook/schema';
import {
  loadPackClip,
  loadSkeletonRestFromFile,
  retargetClip,
  sampleClip,
  writePoses,
} from '@spritebook/anim';
import { UAL_HUMANOID } from '../anim/profile.ts';
import { tryGetGpu } from './gpu.ts';
import {
  evalPosesMatrices,
  jointScratch,
  loadSkinnedAsset,
  posedBoundsFromPoses,
} from './skinning.ts';
import { mapPosesJoints, readPoses } from './poses.ts';
import { solveFraming } from './camera.ts';
import { Renderer } from './renderer.ts';

const win = (u: URL) => decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BODY = win(new URL('../rig/bodies/ubc-male/body.glb', import.meta.url));
const PACK = win(new URL('../anim/packs/ual', import.meta.url));
const SHADERS = new URL('./shaders.wgsl', import.meta.url);

/** Arms-out so the hand clears the torso; dense enough that a fist is pixels. */
const CAM: CameraPreset = {
  id: 'attach-30x8',
  elevationDeg: 30,
  directions: 8,
  yawOffsetDeg: 0,
  pixelsPerMeter: 48,
  cellPx: { w: 128, h: 128 },
  paddingPx: 8,
  pivot: 'feet-baseline',
  orthographic: true,
};

/** The signature colour of the prop, straight from baseColorFactor. */
const INK: readonly [number, number, number, number] = [255, 0, 255, 255];

/** Half-edge of the cube prop, metres. */
const PROP_HALF_M = 0.06;

/**
 * How far the nearest VISIBLE prop pixel may sit from the hand joint.
 *
 * The prop is a cube centred on the joint, so when it is fully visible some
 * pixel sits right on the joint. Mid-swing the body can occlude everything but
 * one far corner, and a corner is half-diagonal away — that distance, not a
 * round number, is the honest bound. (+1 px for the rasterizer landing on
 * texel centres.) At 48 px/m this is ~6 px, while the origin — where the bug
 * used to put the prop — is 58 px away, so the two remain far apart.
 */
const HAND_TOL_PX = PROP_HALF_M * Math.sqrt(3) * CAM.pixelsPerMeter + 1;

/**
 * Write the bundled body, optionally with a magenta cube hung under `hand_r`
 * exactly the way applyAttachments does it: an unskinned mesh subtree parented
 * to the joint node through a wrapper carrying the socket offset.
 */
async function bodyWithProp(outPath: string, attach: boolean): Promise<void> {
  const doc = await new NodeIO().readBinary(await Deno.readFile(BODY));
  if (attach) {
    const buffer = doc.getRoot().listBuffers()[0];
    const s = PROP_HALF_M; // a 12cm cube: a fist-sized hilt, several px at 48 px/m
    const P: number[] = [];
    const N: number[] = [];
    const I: number[] = [];
    // six faces, flat-shaded, so the cube reads from every direction
    const faces: [number, number, number][][] = [
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
      [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
      [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]],
      [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
      [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]],
      [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
    ];
    const normals: [number, number, number][] = [
      [0, 0, 1],
      [0, 0, -1],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
    ];
    faces.forEach((quad, f) => {
      const base = P.length / 3;
      for (const [x, y, z] of quad) {
        P.push(x * s, y * s, z * s);
        N.push(...normals[f]);
      }
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    const acc = (type: 'VEC3' | 'SCALAR', array: ArrayLike<number>) =>
      doc.createAccessor().setType(type).setArray(array as never).setBuffer(buffer);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', new Float32Array(P)))
      .setAttribute('NORMAL', acc('VEC3', new Float32Array(N)))
      .setIndices(acc('SCALAR', new Uint16Array(I)))
      .setMaterial(
        doc.createMaterial('sword').setBaseColorFactor([1, 0, 1, 1]).setMetallicFactor(0)
          .setRoughnessFactor(1),
      );
    const hand = doc.getRoot().listSkins()[0].listJoints().find((j) => j.getName() === 'hand_r');
    assert(hand, 'the bundled body has a hand_r joint');
    hand.addChild(
      doc.createNode('attach-sword').addChild(
        doc.createNode('sword').setMesh(doc.createMesh('sword-mesh').addPrimitive(prim)),
      ),
    );
  }
  await Deno.writeFile(outPath, await new NodeIO().writeBinary(doc));
}

/**
 * clip = proj * view * p, then the same NDC->pixel mapping camera.ts solves:
 *   px = w * (ndcX + 1) / 2      py = h * (1 - ndcY) / 2
 */
function projectPx(
  view: Float32Array,
  proj: Float32Array,
  p: readonly [number, number, number],
  w: number,
  h: number,
) {
  const mul = (m: Float32Array, v: number[]) => [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
  const clip = mul(proj, mul(view, [p[0], p[1], p[2], 1]));
  const iw = clip[3] === 0 ? 1 : clip[3];
  return { x: w * (clip[0] / iw + 1) / 2, y: h * (1 - clip[1] / iw) / 2 };
}

/** Pixels of an albedo plane that carry exactly the prop's colour. */
function inkPixels(albedo: Uint8Array, w: number, h: number) {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (
        albedo[i] === INK[0] && albedo[i + 1] === INK[1] &&
        albedo[i + 2] === INK[2] && albedo[i + 3] === INK[3]
      ) out.push({ x, y });
    }
  }
  return out;
}

const nearest = (px: { x: number; y: number }[], to: { x: number; y: number }) =>
  px.reduce((best, p) => Math.min(best, Math.hypot(p.x - to.x, p.y - to.y)), Infinity);

/** Set up the renderer for one model over one clip's sampled poses. */
async function rig(modelPath: string, posesPath: string, frames: number, clipId: string) {
  const g = await tryGetGpu();
  if (!g) return null;
  const asset = await loadSkinnedAsset(modelPath);

  const targetRest = await loadSkeletonRestFromFile(modelPath);
  const source = await loadPackClip(PACK, clipId);
  const sourceRest = await loadSkeletonRestFromFile(`${PACK}/clips/${clipId}.glb`);
  const { clip } = retargetClip(source, sourceRest, targetRest, UAL_HUMANOID);
  await writePoses(
    posesPath,
    clipId,
    sampleClip(clip, targetRest, { frames, speed: 1, holdLast: true }),
  );

  const { header, data } = await readPoses(posesPath);
  const map = mapPosesJoints(asset.jointNames, header);
  const jointsPerFrame = header.jointNames.length;
  const bounds = posedBoundsFromPoses(asset, data, map, jointsPerFrame, frames);
  const framing = solveFraming(CAM, bounds);
  const renderer = await Renderer.create(
    g,
    asset,
    framing,
    await Deno.readTextFile(SHADERS),
    CAM.cellPx.w,
    CAM.cellPx.h,
    'clip',
    { data, map, jointsPerFrame },
  );
  return { asset, framing, renderer, data, map, jointsPerFrame, bounds };
}

/** hand_r's world position at a frame, straight from the pose blob. */
function handAt(
  r: NonNullable<Awaited<ReturnType<typeof rig>>>,
  frame: number,
  scratch: { mats: Float32Array; worlds: Float32Array },
) {
  const i = r.asset.jointNames.indexOf('hand_r');
  evalPosesMatrices(r.asset, r.data, r.map, r.jointsPerFrame, frame, scratch.mats, scratch.worlds);
  return [
    scratch.worlds[i * 16 + 12],
    scratch.worlds[i * 16 + 13],
    scratch.worlds[i * 16 + 14],
  ] as const;
}

Deno.test('ACCEPTANCE: a socketed sword bakes IN THE HAND, in every direction', async (t) => {
  if (!(await tryGetGpu())) return;
  const dir = await Deno.makeTempDir({ prefix: 'sb-attach-' });
  try {
    const armed = `${dir}/armed.glb`;
    const bare = `${dir}/bare.glb`;
    await bodyWithProp(armed, true);
    await bodyWithProp(bare, false);

    // a-tpose: arms away from the body, so the hand is unoccluded everywhere
    const A = (await rig(armed, `${dir}/a.poses`, 1, 'a-tpose'))!;
    const B = (await rig(bare, `${dir}/b.poses`, 1, 'a-tpose'))!;
    const scratch = jointScratch(A.asset);
    const { w, h } = CAM.cellPx;

    await t.step('the projector agrees with the framing solver', () => {
      // feet-baseline anchors (cx, 0, cz) — the footprint centre on the ground
      // (camera.ts). If projectPx reproduces framing.pivotPx from that anchor
      // in every direction, it is provably the inverse of the framing solve,
      // and every distance measured with it below is trustworthy.
      const cx = (A.bounds.min[0] + A.bounds.max[0]) / 2;
      const cz = (A.bounds.min[2] + A.bounds.max[2]) / 2;
      for (let d = 0; d < CAM.directions; d++) {
        const c = A.framing.cameras[d];
        const p = projectPx(c.view, c.proj, [cx, 0, cz], w, h);
        assertAlmostEquals(p.x, A.framing.pivotPx.x, 1e-3, `direction ${d} pivot x`);
        assertAlmostEquals(p.y, A.framing.pivotPx.y, 1e-3, `direction ${d} pivot y`);
      }
    });

    await t.step('the un-attached body shows no prop pixels at all (control)', async () => {
      for (let d = 0; d < CAM.directions; d++) {
        const planes = await B.renderer.capturePadded(d, 0);
        assertEquals(inkPixels(planes[1], w, h).length, 0, `direction ${d} has no magenta`);
      }
    });

    await t.step('the sword is visible and lands on the hand in all 8 directions', async () => {
      const hand = handAt(A, 0, scratch);
      const report: string[] = [];
      for (let d = 0; d < CAM.directions; d++) {
        const planes = await A.renderer.capturePadded(d, 0);
        const px = inkPixels(planes[1], w, h);
        const cam = A.framing.cameras[d];
        const at = projectPx(cam.view, cam.proj, hand, w, h);
        const origin = projectPx(cam.view, cam.proj, [0, 0, 0], w, h);
        const dHand = nearest(px, at);
        const dOrigin = nearest(px, origin);
        report.push(`d${d}:${px.length}px hand=${dHand.toFixed(1)} origin=${dOrigin.toFixed(1)}`);
        assert(px.length >= 4, `direction ${d}: only ${px.length} prop px (${report.join(' ')})`);
        assert(
          dHand <= 4,
          `direction ${d}: nearest prop px is ${dHand.toFixed(1)}px from the hand`,
        );
        // THE REGRESSION GUARD: the old bug drew the prop at the model origin
        assert(
          dOrigin > 20,
          `direction ${d}: prop sits ${dOrigin.toFixed(1)}px from the ORIGIN - that is the bug`,
        );
      }
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('ACCEPTANCE: the sword STAYS in the hand while the clip swings it', async (t) => {
  if (!(await tryGetGpu())) return;
  const dir = await Deno.makeTempDir({ prefix: 'sb-attach-clip-' });
  try {
    const armed = `${dir}/armed.glb`;
    await bodyWithProp(armed, true);
    const FRAMES = 8;
    const A = (await rig(armed, `${dir}/sword.poses`, FRAMES, 'sword-attack'))!;
    const scratch = jointScratch(A.asset);
    const { w, h } = CAM.cellPx;

    const handPx: { x: number; y: number }[] = [];
    await t.step('every frame of every direction keeps the prop on the hand', async () => {
      for (let d = 0; d < CAM.directions; d++) {
        for (let f = 0; f < FRAMES; f++) {
          const planes = await A.renderer.capturePadded(d, f);
          const px = inkPixels(planes[1], w, h);
          const cam = A.framing.cameras[d];
          const at = projectPx(cam.view, cam.proj, handAt(A, f, scratch), w, h);
          if (d === 0) handPx.push(at);
          if (px.length === 0) continue; // fully occluded behind the body is legal
          assert(
            nearest(px, at) <= HAND_TOL_PX,
            `d${d} f${f}: nearest prop px ${nearest(px, at).toFixed(1)}px from the hand ` +
              `(tolerance ${HAND_TOL_PX.toFixed(1)}px)`,
          );
        }
      }
    });

    await t.step('and the hand really moved, so that was not vacuous', () => {
      const spread = Math.max(
        ...handPx.map((p) => Math.hypot(p.x - handPx[0].x, p.y - handPx[0].y)),
      );
      assert(spread >= 8, `the swing must move the hand on screen; moved ${spread.toFixed(1)}px`);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
