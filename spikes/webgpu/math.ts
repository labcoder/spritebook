// Minimal column-major mat4 helpers for the P0-T2 spike. No dependency —
// gl-matrix would be a new BOM row for ~80 lines of code we can own.

export type Mat4 = Float32Array; // 16 elements, column-major (WebGPU/glTF convention)

export function mat4Identity(out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  m.fill(0);
  m[0] =
    m[5] =
    m[10] =
    m[15] =
      1;
  return m;
}

/** out = a * b (may not alias a or b) */
export function mat4Multiply(a: Mat4, b: Mat4, out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
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

export function mat4RotationZ(rad: number, out?: Mat4): Mat4 {
  const m = mat4Identity(out);
  const c = Math.cos(rad), s = Math.sin(rad);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
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

/** Right-handed, WebGPU clip space (z in [0,1]). */
export function mat4Perspective(fovYRad: number, aspect: number, near: number, far: number): Mat4 {
  const m = new Float32Array(16);
  const f = 1 / Math.tan(fovYRad / 2);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
}

type Vec3 = [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
}

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
