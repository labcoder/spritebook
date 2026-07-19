/**
 * Quaternion / vec3 / mat4 helpers for @spritebook/anim (P3-T1). Pure TS, no
 * imports — retarget math stays dependency-free and deterministic.
 *
 * Conventions (everything in this package leans on these; do not change
 * silently):
 * - `Quat` is `[x, y, z, w]` — glTF component order. Unit length unless a
 *   function documents otherwise.
 * - `qMul(a, b)` is the Hamilton product a ⊗ b in the column-vector
 *   convention: the product applies b FIRST, then a, i.e.
 *   `qRotate(qMul(a, b), v) === qRotate(a, qRotate(b, v))`. Joint-chain
 *   composition is therefore `worldRot = qMul(parentWorldRot, localRot)`.
 * - `Mat4` is column-major `Float32Array(16)` — the house convention
 *   (packages/render/math.ts, glTF, WebGPU). `qToMat4(qAxisAngle([0,1,0], a))`
 *   equals render/math.ts `mat4RotationY(a)` by construction.
 * - Math runs in doubles; callers narrow to Float32 at track boundaries.
 */

export type Quat = [number, number, number, number];
export type Vec3 = [number, number, number];

export function qIdentity(): Quat {
  return [0, 0, 0, 1];
}

export function qDot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/** Unit-normalize; throws on a near-zero quaternion (corrupt data fails loud). */
export function qNormalize(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len < 1e-12) throw new Error('qNormalize: zero-length quaternion');
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/** Conjugate (= inverse for unit quats). */
export function qConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Hamilton product a ⊗ b (applies b first, then a). */
export function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Rotate v by unit quat q. */
export function qRotate(q: Quat, v: Vec3): Vec3 {
  // t = 2 (q.xyz × v); v' = v + w·t + (q.xyz × t)
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Shortest-path spherical interpolation between unit quats, t in [0, 1]. */
export function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let d = qDot(a, b);
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  if (d < 0) {
    // hemisphere flip: interpolate the short way around
    d = -d;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let wa: number;
  let wb: number;
  if (d > 0.9995) {
    // nearly parallel: nlerp is numerically safer and indistinguishable
    wa = 1 - t;
    wb = t;
  } else {
    const theta = Math.acos(Math.min(1, d));
    const s = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / s;
    wb = Math.sin(t * theta) / s;
  }
  return qNormalize([
    a[0] * wa + bx * wb,
    a[1] * wa + by * wb,
    a[2] * wa + bz * wb,
    a[3] * wa + bw * wb,
  ]);
}

/** Unit quat rotating by `rad` about `axis` (axis need not be unit length). */
export function qAxisAngle(axis: Vec3, rad: number): Quat {
  const n = vNormalize(axis);
  const s = Math.sin(rad / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(rad / 2)];
}

/** Angular distance (radians, in [0, π]) between two unit-quat orientations. */
export function qAngle(a: Quat, b: Quat): number {
  return 2 * Math.acos(Math.min(1, Math.abs(qDot(a, b))));
}

/**
 * Rotation quat from a column-major mat4. Basis columns are normalized first,
 * so uniform positive scale is tolerated; a mirrored (negative-determinant)
 * matrix throws — a mirrored rest joint is corrupt input for orientation
 * retargeting, never something to guess through.
 */
export function qFromMat4(m: ArrayLike<number>): Quat {
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  if (sx < 1e-9 || sy < 1e-9 || sz < 1e-9) {
    throw new Error('qFromMat4: degenerate basis (zero-length column)');
  }
  const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
  const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
  const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
  const det = r00 * (r11 * r22 - r12 * r21) - r01 * (r10 * r22 - r12 * r20) +
    r02 * (r10 * r21 - r11 * r20);
  if (det < 0) {
    throw new Error('qFromMat4: mirrored (negative-determinant) matrix is not a rotation');
  }
  const trace = r00 + r11 + r22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (r21 - r12) / s;
    y = (r02 - r20) / s;
    z = (r10 - r01) / s;
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    w = (r21 - r12) / s;
    x = s / 4;
    y = (r01 + r10) / s;
    z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    w = (r02 - r20) / s;
    x = (r01 + r10) / s;
    y = s / 4;
    z = (r12 + r21) / s;
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    w = (r10 - r01) / s;
    x = (r02 + r20) / s;
    y = (r12 + r21) / s;
    z = s / 4;
  }
  return qNormalize([x, y, z, w]);
}

/** Column-major rotation mat4 from a unit quat. */
export function qToMat4(q: Quat, out?: Float32Array): Float32Array {
  const m = out ?? new Float32Array(16);
  const [x, y, z, w] = q;
  m.fill(0);
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y + w * z);
  m[2] = 2 * (x * z - w * y);
  m[4] = 2 * (x * y - w * z);
  m[5] = 1 - 2 * (x * x + z * z);
  m[6] = 2 * (y * z + w * x);
  m[8] = 2 * (x * z + w * y);
  m[9] = 2 * (y * z - w * x);
  m[10] = 1 - 2 * (x * x + y * y);
  m[15] = 1;
  return m;
}

// --------------------------------------------------------------------------
// vec3
// --------------------------------------------------------------------------

export function vAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vScale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function vDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vCross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function vLen(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Unit-normalize; throws on a near-zero vector (fail loud, never guess). */
export function vNormalize(a: Vec3): Vec3 {
  const l = vLen(a);
  if (l < 1e-12) throw new Error('vNormalize: zero-length vector');
  return [a[0] / l, a[1] / l, a[2] / l];
}
