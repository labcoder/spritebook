/**
 * Orthographic framing solver for @spritebook/render (P2-T1). Pure math — no
 * GPU, no wall clock, no `Math.random`, no globals — so the structural golden
 * suite runs it anywhere and `solveFraming(x)` twice is byte-identical.
 *
 * Conventions (repo-wide, see contracts.ts / math.ts):
 *  - mat4 = Float32Array(16), COLUMN-MAJOR; right-handed view space (camera
 *    looks down -Z); WebGPU clip z in [0, 1]; world up = +Y; feet on world Y=0.
 *  - Framebuffer pixel coords: origin top-left, x right, y down, in texels. An
 *    integer coordinate `k` is the LEFT/TOP EDGE of texel `k`; the texel centre
 *    is `k + 0.5`; the image spans [0, w] x [0, h]. WebGPU's viewport maps
 *    NDC (0,0) to framebuffer (w/2, h/2).
 *
 * The framing model (derived + unit-tested in camera_test.ts):
 *
 *  1. World-locked scale. `mpp = 1 / pixelsPerMeter` is the world size of one
 *     texel; one metre is ALWAYS `pixelsPerMeter` px, for every model in the
 *     roster. Ortho half-extents: halfW = (w/2)*mpp, halfH = (h/2)*mpp; the
 *     frustum is [-halfW, halfW] x [-halfH, halfH]. Because the frustum never
 *     depends on the bounds, the world->pixel scale is identical across models:
 *     a 2 m silhouette spans exactly 2x the pixels of a 1 m one. Vertically the
 *     scale foreshortens to `cos(el)/mpp` px per metre (the view-up vector's
 *     world-Y component is exactly cos(el)); el = 0 => no vertical foreshorten.
 *
 *  2. Camera orbit. Direction i has yaw = yawOffsetDeg + i*(360/directions).
 *     The unit vector target->eye is
 *       dir = (cos el * sin az, sin el, cos el * cos az),
 *     eye = target + D*dir for a D chosen large enough to bracket the model in
 *     front of near (ortho scale is D-independent).
 *
 *  3. Pivot solve (why the pivot is identical in every direction). A semantic
 *     anchor A (a world point derived from the pivot mode) is driven to land on
 *     the pivot texel P by shifting the look target within the camera's screen
 *     plane: with ox = ndcX*halfW, oy = ndcY*halfH the target is
 *       L = A - ox*s - oy*u,  eye = L + D*dir,
 *     which makes A project to exactly (ndcX, ndcY) in EVERY direction, because
 *     ox/oy are D- and az-independent. P is a pure function of the preset (w, h,
 *     paddingPx, xPct, yPct) — never the bounds — so it lands on the same texel
 *     for every direction AND every model. That is the world-lock the packer
 *     relies on (FrameRecord.pivotPx).
 *
 *  4. Pivot per mode (A = anchor, P = target pixel, cx/cz = footprint centre):
 *       center        A = (cx, (minY+maxY)/2, cz)   P = (w/2, h/2)
 *       feet-baseline A = (cx, 0, cz)               P = (w/2, h - paddingPx)
 *       {xPct,yPct}   A = (cx, (minY+maxY)/2, cz)   P = (w*xPct/100, h*yPct/100)
 *     feet-baseline pins the feet (world Y=0) to the baseline row; center and
 *     the custom pivot pin the bounding-box centre to their pixel. The closed
 *     form ty = mpp*(h/2 - paddingPx)/cos(el) from the T-at-screen-centre view
 *     of feet-baseline is equivalent and is asserted by projection in the tests.
 *
 * Texel-snap convention (the anti-crawl guarantee):
 *  - EDGE convention: the pivot is quantised to the integer texel lattice
 *    (`Math.round`), i.e. it sits on a texel edge with sub-texel phase 0.
 *  - The camera is then solved to hit that snapped pivot EXACTLY, so the pivot's
 *    sub-texel phase is identically 0 in every direction and for every model —
 *    no sub-pixel jitter. Because P depends only on the preset, a sub-texel
 *    translation of the bounds cannot change which texel the pivot occupies, and
 *    purity makes a repeated solve byte-identical.
 *
 * Domain: elevationDeg in [0, 90). At exactly 90 deg (top-down) the world up
 * (+Y) is parallel to the view direction and both the look-at basis and the
 * feet-baseline foreshortening (cos el -> 0) degenerate; callers keep presets
 * below 90 (GUI detents are 15 / 26.565 / 30 / 35.264).
 */
import type { CameraPreset } from '@spritebook/schema';
import type { DirectionCamera, FramingResult, ModelBounds, SolveFraming } from './contracts.ts';
import { mat4LookAt, mat4Ortho, normalize, type Vec3 } from './math.ts';

const DEG2RAD = Math.PI / 180;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** a + b*k */
function addScaled(a: Vec3, b: Vec3, k: number): Vec3 {
  return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
}

/** The 8 corners of an axis-aligned box, in a fixed, deterministic order. */
function boxCorners(bounds: ModelBounds): Vec3[] {
  const { min, max } = bounds;
  const out: Vec3[] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        out.push([x, y, z]);
      }
    }
  }
  return out;
}

/** Semantic anchor (world point) and its target pixel for the preset's pivot. */
function resolvePivot(
  preset: CameraPreset,
  cx: number,
  cz: number,
  centerY: number,
): { anchor: Vec3; px: { x: number; y: number } } {
  const { w, h } = preset.cellPx;
  const { pivot } = preset;
  if (pivot === 'feet-baseline') {
    return { anchor: [cx, 0, cz], px: { x: w / 2, y: h - preset.paddingPx } };
  }
  if (pivot === 'center') {
    return { anchor: [cx, centerY, cz], px: { x: w / 2, y: h / 2 } };
  }
  // { xPct, yPct }: pin the bounding-box centre to the requested pixel.
  return {
    anchor: [cx, centerY, cz],
    px: { x: (pivot.xPct / 100) * w, y: (pivot.yPct / 100) * h },
  };
}

export const solveFraming: SolveFraming = (
  preset: CameraPreset,
  bounds: ModelBounds,
): FramingResult => {
  if (preset.elevationDeg >= 90) {
    // at 90° world-up ∥ view direction: the look-at basis and the cos(el)
    // foreshortening both degenerate (silent collapse to a vertical line).
    throw new Error(
      `elevationDeg must be < 90 (got ${preset.elevationDeg}); ` +
        `top-down needs a separate up-vector path`,
    );
  }
  const { min, max } = bounds;
  const mpp = 1 / preset.pixelsPerMeter;
  const { w, h } = preset.cellPx;
  const halfW = (w / 2) * mpp;
  const halfH = (h / 2) * mpp;

  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const centerY = (min[1] + max[1]) / 2;

  const { anchor, px } = resolvePivot(preset, cx, cz, centerY);

  // EDGE convention: snap the pivot onto the integer texel lattice (phase 0),
  // then solve every camera to hit it exactly.
  const pivotPx = { x: Math.round(px.x), y: Math.round(px.y) };
  const ndcX = (2 * pivotPx.x) / w - 1;
  const ndcY = 1 - (2 * pivotPx.y) / h;
  const ox = ndcX * halfW;
  const oy = ndcY * halfH;

  const up: Vec3 = [0, 1, 0];
  const corners = boxCorners(bounds);
  const el = preset.elevationDeg * DEG2RAD;
  const ce = Math.cos(el);
  const se = Math.sin(el);
  const step = 360 / preset.directions;

  const cameras: DirectionCamera[] = [];
  for (let i = 0; i < preset.directions; i++) {
    const yawDeg = preset.yawOffsetDeg + i * step;
    const az = yawDeg * DEG2RAD;
    const ca = Math.cos(az);
    const sa = Math.sin(az);

    // Orbit basis. dir = target->eye; f = -dir; s, u exactly as mat4LookAt
    // reconstructs them, so the solved eye/target project the anchor onto P.
    const dir: Vec3 = [ce * sa, se, ce * ca];
    const f = normalize([-dir[0], -dir[1], -dir[2]]);
    const s = normalize(cross(f, up));
    const u = cross(s, f);

    // Target shifted so the anchor lands on the pivot pixel; eye D behind it.
    const look = addScaled(addScaled(anchor, s, -ox), u, -oy);

    // near/far bracket: depth_i = D + dot(f, corner_i - look). Pick D so the
    // nearest corner sits 2*margin in front and near = margin > 0, with every
    // corner strictly inside (near, far).
    let hMin = Infinity;
    let hMax = -Infinity;
    for (const c of corners) {
      const hc = dot(f, [c[0] - look[0], c[1] - look[1], c[2] - look[2]]);
      if (hc < hMin) hMin = hc;
      if (hc > hMax) hMax = hc;
    }
    const margin = mpp + 0.01 * (hMax - hMin);
    const dist = 2 * margin - hMin;
    const near = margin;
    const far = hMax + dist + margin;

    const eye = addScaled(look, dir, dist);
    const view = mat4LookAt(eye, look, up);
    const proj = mat4Ortho(-halfW, halfW, -halfH, halfH, near, far);

    cameras.push({ dirIndex: i, yawDeg, view, proj, near, far });
  }

  return { cameras, pivotPx, metersPerPixel: mpp };
};
