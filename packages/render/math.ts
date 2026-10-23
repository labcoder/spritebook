/**
 * Column-major mat4 helpers (WebGPU/glTF convention), promoted from the P0-T2
 * spike and extended with `mat4Ortho` for the P2 orthographic camera. No
 * dependency — this is ~100 lines we own rather than a gl-matrix BOM row.
 *
 * Convention: mat4 is a Float32Array(16), column-major. Right-handed view
 * space (camera looks down -Z); WebGPU clip space has z in [0, 1].
 */

export type Mat4 = Float32Array;
export type Vec3 = readonly [number, number, number];

export function mat4Identity(out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  m.fill(0);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** out = a * b (out may not alias a or b). */
export function mat4Multiply(a: Mat4, b: Mat4, out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return m;
}

export function mat4Translation(x: number, y: number, z: number, out?: Mat4): Mat4 {
  const m = mat4Identity(out);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function mat4RotationY(rad: number, out?: Mat4): Mat4 {
  const m = mat4Identity(out);
  const c = Math.cos(rad), s = Math.sin(rad);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export function mat4RotationZ(rad: number, out?: Mat4): Mat4 {
  const m = mat4Identity(out);
  const c = Math.cos(rad), s = Math.sin(rad);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

/**
 * Right-handed orthographic projection, WebGPU clip space (z in [0, 1]).
 * A view-space point at z = -near maps to clip z = 0, z = -far maps to 1.
 */
export function mat4Ortho(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
  out?: Mat4,
): Mat4 {
  const m = out ?? new Float32Array(16);
  m.fill(0);
  m[0] = 2 / (right - left);
  m[5] = 2 / (top - bottom);
  m[10] = 1 / (near - far);
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = near / (near - far);
  m[15] = 1;
  return m;
}

/** Right-handed perspective, WebGPU z in [0, 1]. */
export function mat4Perspective(
  fovRadians: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const m = new Float32Array(16), f = 1 / Math.tan(fovRadians / 2);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = near * far / (near - far);
  return m;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Right-handed look-at view matrix (column-major). */
export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const f = normalize(sub(target, eye));
  const s = normalize(cross(f, up));
  const u = cross(s, f);
  const m = new Float32Array(16);
  m[0] = s[0];
  m[1] = u[0];
  m[2] = -f[0];
  m[4] = s[1];
  m[5] = u[1];
  m[6] = -f[1];
  m[8] = s[2];
  m[9] = u[2];
  m[10] = -f[2];
  m[12] = -dot(s, eye);
  m[13] = -dot(u, eye);
  m[14] = dot(f, eye);
  m[15] = 1;
  return m;
}
