import { test } from 'node:test';
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { CameraPresetSchema } from '@spritebook/schema';
import type { CameraPreset } from '@spritebook/schema';
import type { DirectionCamera, ModelBounds } from './dist/contracts.js';
import { solveFraming } from './dist/camera.js';

// f32-stored matrices read back into f64 math carry ~1e-4 px of rounding for
// cell coords in the low hundreds; 1e-2 px is comfortably tight and far under
// the 0.5 px the pivot/feet invariants care about.
const EPS_PX = 1e-2;
const EPS_NDC = 1e-4;

test('perspective preserves the pivot and foreshortens depth at a fixed capture scale', () => {
  const p = preset({ orthographic: false, fovDeg: 40, elevationDeg: 0, pivot: 'center' });
  const result = solveFraming(p, { min: [-.5, 0, -.25], max: [.5, 2, .25] });
  for (const camera of result.cameras) {
    const pivot = project(camera, [0, 1, 0], p.cellPx.w, p.cellPx.h);
    assertAlmostEquals(pivot.x, result.pivotPx.x, EPS_PX);
    assertAlmostEquals(pivot.y, result.pivotPx.y, EPS_PX);
    assert(pivot.ndcZ > 0 && pivot.ndcZ < 1);
  }
  const camera = result.cameras[0];
  const near = project(camera, [.25, 1, .2], p.cellPx.w, p.cellPx.h);
  const far = project(camera, [.25, 1, -.2], p.cellPx.w, p.cellPx.h);
  assert(near.x - result.pivotPx.x > far.x - result.pivotPx.x, 'near details appear larger');
});

function preset(overrides: Partial<CameraPreset> = {}): CameraPreset {
  return CameraPresetSchema.parse({
    id: 'test',
    elevationDeg: 30,
    directions: 8,
    yawOffsetDeg: 0,
    pixelsPerMeter: 100,
    cellPx: { w: 128, h: 256 },
    paddingPx: 8,
    pivot: 'feet-baseline',
    orthographic: true,
    ...overrides,
  });
}

/** Column-major mat4 (Float32Array) times a vec4. */
function mul(m: Float32Array, v: readonly [number, number, number, number]): number[] {
  const o = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) {
    o[r] = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3];
  }
  return o;
}

/** Project a world point through a camera to framebuffer pixels + NDC + depth. */
function project(cam: DirectionCamera, p: readonly [number, number, number], w: number, h: number) {
  const view = mul(cam.view, [p[0], p[1], p[2], 1]);
  const clip = mul(cam.proj, [view[0], view[1], view[2], view[3]]);
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  const ndcZ = clip[2] / clip[3];
  return {
    x: (ndcX * 0.5 + 0.5) * w,
    y: (0.5 - ndcY * 0.5) * h,
    ndcX,
    ndcY,
    ndcZ,
    depth: -view[2], // view-space distance in front of the camera
  };
}

function boxCorners(b: ModelBounds): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const x of [b.min[0], b.max[0]]) {
    for (const y of [b.min[1], b.max[1]]) {
      for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
    }
  }
  return out;
}

const person: ModelBounds = { min: [-0.3, 0, -0.2], max: [0.3, 1.8, 0.2] };

test('ortho maps frustum edges to NDC +/-1 (el=0, az=0, center pivot)', () => {
  const p = preset({ pivot: 'center', elevationDeg: 0, directions: 4 });
  const { cameras } = solveFraming(p, person);
  const mpp = 1 / p.pixelsPerMeter;
  const halfW = (p.cellPx.w / 2) * mpp;
  const halfH = (p.cellPx.h / 2) * mpp;
  const cx = 0, cz = 0;
  const cy = (person.min[1] + person.max[1]) / 2;
  const cam = cameras[0]; // yaw 0: screen right = +x, screen up = +y

  const c = project(cam, [cx, cy, cz], p.cellPx.w, p.cellPx.h);
  assertAlmostEquals(c.ndcX, 0, EPS_NDC);
  assertAlmostEquals(c.ndcY, 0, EPS_NDC);

  const right = project(cam, [cx + halfW, cy, cz], p.cellPx.w, p.cellPx.h);
  assertAlmostEquals(right.ndcX, 1, EPS_NDC);
  const top = project(cam, [cx, cy + halfH, cz], p.cellPx.w, p.cellPx.h);
  assertAlmostEquals(top.ndcY, 1, EPS_NDC);
});

test('pivot pixel is integer, exact, and identical across all directions', () => {
  for (const directions of [2, 4, 8, 16] as const) {
    const p = preset({ directions, pivot: 'feet-baseline' });
    const { cameras, pivotPx } = solveFraming(p, person);

    assertEquals(cameras.length, directions);
    assertEquals(pivotPx.x, Math.round(pivotPx.x), `dir=${directions} pivot.x integral`);
    assertEquals(pivotPx.y, Math.round(pivotPx.y), `dir=${directions} pivot.y integral`);
    assertEquals(pivotPx.y, p.cellPx.h - p.paddingPx);

    const feet: [number, number, number] = [0, 0, 0];
    const step = 360 / directions;
    cameras.forEach((cam, i) => {
      assertEquals(cam.dirIndex, i);
      assertAlmostEquals(cam.yawDeg, p.yawOffsetDeg + i * step, 1e-9);
      const f = project(cam, feet, p.cellPx.w, p.cellPx.h);
      // the anchor lands on exactly the pivot texel in EVERY direction
      assertAlmostEquals(f.x, pivotPx.x, EPS_PX, `dir=${directions} i=${i} feet.x`);
      assertAlmostEquals(f.y, pivotPx.y, EPS_PX, `dir=${directions} i=${i} feet.y`);
    });
  }
});

test('world-lock: one preset, two models share the world->pixel scale exactly', () => {
  const p = preset({ pivot: 'feet-baseline', elevationDeg: 30 });
  const { w, h } = p.cellPx;
  const ppm = p.pixelsPerMeter;
  const cosEl = Math.cos(p.elevationDeg * Math.PI / 180);

  const oneM: ModelBounds = { min: [-0.2, 0, -0.2], max: [0.2, 1, 0.2] };
  const twoM: ModelBounds = { min: [-0.2, 0, -0.2], max: [0.2, 2, 0.2] };
  const a = solveFraming(p, oneM).cameras[0];
  const b = solveFraming(p, twoM).cameras[0];

  const spanY = (cam: DirectionCamera, top: number) =>
    project(cam, [0, 0, 0], w, h).y - project(cam, [0, top, 0], w, h).y;
  const spanX = (cam: DirectionCamera) =>
    project(cam, [0.5, 0, 0], w, h).x - project(cam, [-0.5, 0, 0], w, h).x;

  const vA = spanY(a, 1); // px spanned by a 1 m tall silhouette
  const vB = spanY(b, 2); // px spanned by a 2 m tall silhouette

  // vertical scale foreshortens by cos(el) and is bounds-independent
  assertAlmostEquals(vA, 1 * cosEl * ppm, EPS_PX);
  assertAlmostEquals(vB, 2 * cosEl * ppm, EPS_PX);
  assertAlmostEquals(vB, 2 * vA, EPS_PX); // 2 m spans exactly twice the 1 m
  assertAlmostEquals(vB / 2, vA / 1, EPS_PX); // identical px-per-metre

  // horizontal scale is the raw ruler (no foreshortening), same for both models
  assertAlmostEquals(spanX(a), 1 * ppm, EPS_PX);
  assertAlmostEquals(spanX(b), 1 * ppm, EPS_PX);
});

test('texel-snap: solving twice is byte-identical', () => {
  const p = preset({ directions: 16 });
  const first = solveFraming(p, person);
  const second = solveFraming(p, person);
  assertEquals(first.pivotPx, second.pivotPx);
  assertEquals(first.metersPerPixel, second.metersPerPixel);
  first.cameras.forEach((cam, i) => {
    assertEquals(Array.from(cam.view), Array.from(second.cameras[i].view));
    assertEquals(Array.from(cam.proj), Array.from(second.cameras[i].proj));
    assertEquals(cam.near, second.cameras[i].near);
    assertEquals(cam.far, second.cameras[i].far);
  });
});

test('texel-snap: a sub-texel bounds shift keeps the pivot on the same texel', () => {
  const p = preset({ pivot: 'feet-baseline', directions: 8 });
  const mpp = 1 / p.pixelsPerMeter;
  const nudge = mpp * 0.1; // one tenth of a texel, well under half

  const base = solveFraming(p, person);
  const shifted = solveFraming(p, {
    min: [person.min[0] + nudge, person.min[1], person.min[2] + nudge],
    max: [person.max[0] + nudge, person.max[1], person.max[2] + nudge],
  });

  // pivot texel is a pure function of the preset -> byte-identical
  assertEquals(shifted.pivotPx, base.pivotPx);
  // and the true feet of the nudged model still resolve inside that same texel
  for (const cam of shifted.cameras) {
    const f = project(cam, [nudge, 0, nudge], p.cellPx.w, p.cellPx.h);
    assertEquals(Math.round(f.x), base.pivotPx.x);
    assertEquals(Math.round(f.y), base.pivotPx.y);
  }
});

test('near > 0, near < far, and all 8 corners fall within [near, far]', () => {
  for (const directions of [2, 4, 8, 16] as const) {
    const p = preset({ directions, elevationDeg: 35.264 });
    const { cameras } = solveFraming(p, person);
    for (const cam of cameras) {
      assert(cam.near > 0, `near>0 (got ${cam.near})`);
      assert(cam.near < cam.far, `near<far (${cam.near} !< ${cam.far})`);
      for (const corner of boxCorners(person)) {
        const { depth, ndcZ } = project(cam, corner, p.cellPx.w, p.cellPx.h);
        assert(
          depth >= cam.near - EPS_PX && depth <= cam.far + EPS_PX,
          `corner depth ${depth} in [${cam.near}, ${cam.far}]`,
        );
        // WebGPU clip z stays in [0, 1] for bracketed geometry
        assert(ndcZ >= -EPS_NDC && ndcZ <= 1 + EPS_NDC, `ndcZ ${ndcZ} in [0,1]`);
      }
    }
  }
});

test('feet-baseline: feet project to row (h - paddingPx) within < 0.5 px', () => {
  const p = preset({ pivot: 'feet-baseline', directions: 8, paddingPx: 12 });
  const { cameras } = solveFraming(p, person);
  const targetRow = p.cellPx.h - p.paddingPx;
  const cx = 0, cz = 0;
  for (const cam of cameras) {
    const f = project(cam, [cx, 0, cz], p.cellPx.w, p.cellPx.h);
    assert(Math.abs(f.y - targetRow) < 0.5, `feet row ${f.y} vs ${targetRow}`);
    assertAlmostEquals(f.y, targetRow, EPS_PX);
  }
});

test('elevation sweep: vertical foreshortening follows cos(el); el=0 has none', () => {
  const H = 1.8;
  const tall: ModelBounds = { min: [-0.2, 0, -0.2], max: [0.2, H, 0.2] };
  let prevSpan = Infinity;
  for (const elevationDeg of [0, 15, 30, 35.264, 45]) {
    const p = preset({ elevationDeg, pivot: 'feet-baseline', directions: 4 });
    const cam = solveFraming(p, tall).cameras[0];
    const span = project(cam, [0, 0, 0], p.cellPx.w, p.cellPx.h).y -
      project(cam, [0, H, 0], p.cellPx.w, p.cellPx.h).y;
    const expected = H * Math.cos(elevationDeg * Math.PI / 180) * p.pixelsPerMeter;
    assertAlmostEquals(span, expected, EPS_PX, `el=${elevationDeg}`);
    if (elevationDeg === 0) {
      assertAlmostEquals(span, H * p.pixelsPerMeter, EPS_PX, 'el=0 => no foreshorten');
    }
    assert(span < prevSpan + EPS_PX, `span shrinks with elevation (el=${elevationDeg})`);
    prevSpan = span;
  }
});

test('center pivot projects the box centre to the image centre', () => {
  const p = preset({ pivot: 'center', directions: 8 });
  const { cameras, pivotPx } = solveFraming(p, person);
  assertEquals(pivotPx, { x: p.cellPx.w / 2, y: p.cellPx.h / 2 });
  const cy = (person.min[1] + person.max[1]) / 2;
  for (const cam of cameras) {
    const c = project(cam, [0, cy, 0], p.cellPx.w, p.cellPx.h);
    assertAlmostEquals(c.x, pivotPx.x, EPS_PX);
    assertAlmostEquals(c.y, pivotPx.y, EPS_PX);
  }
});

test('custom {xPct,yPct} pivot pins the box centre to the requested pixel', () => {
  const p = preset({ pivot: { xPct: 25, yPct: 40 }, directions: 8 });
  const { cameras, pivotPx } = solveFraming(p, person);
  assertEquals(pivotPx, {
    x: Math.round(0.25 * p.cellPx.w),
    y: Math.round(0.40 * p.cellPx.h),
  });
  const cy = (person.min[1] + person.max[1]) / 2;
  for (const cam of cameras) {
    const c = project(cam, [0, cy, 0], p.cellPx.w, p.cellPx.h);
    assert(Math.abs(c.x - pivotPx.x) < 0.5, `centre.x ${c.x} vs ${pivotPx.x}`);
    assert(Math.abs(c.y - pivotPx.y) < 0.5, `centre.y ${c.y} vs ${pivotPx.y}`);
  }
});

test('metersPerPixel is 1/pixelsPerMeter and matrices are NaN-free', () => {
  const p = preset({ pixelsPerMeter: 64 });
  const { cameras, metersPerPixel } = solveFraming(p, person);
  assertAlmostEquals(metersPerPixel, 1 / 64, 1e-12);
  for (const cam of cameras) {
    for (const m of [cam.view, cam.proj]) {
      for (const v of m) assert(Number.isFinite(v), 'matrix entry finite');
    }
  }
});

test('odd cell dimensions still yield an integer (edge-snapped) pivot', () => {
  const p = preset({ cellPx: { w: 65, h: 129 }, pivot: 'center', directions: 4 });
  const { pivotPx } = solveFraming(p, person);
  assertEquals(pivotPx.x, Math.round(65 / 2)); // 33
  assertEquals(pivotPx.y, Math.round(129 / 2)); // 65
});
