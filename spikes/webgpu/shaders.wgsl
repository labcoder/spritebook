// P0-T2 spike shaders: WGSL skinning (joint matrices in a storage buffer) +
// MRT fragment (lit sRGB-encoded + linearized view depth as a color target;
// depth24plus is attachment-only and never read back — see the
// webgpu-headless-rendering skill).

struct Camera {
  view: mat4x4<f32>,
  proj: mat4x4<f32>,
  params: vec4<f32>,   // x = near, y = far
  lightDir: vec4<f32>, // xyz = direction toward light (view of surface)
};

@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var<storage, read> jointMats: array<mat4x4<f32>>;

struct VSIn {
  @location(0) pos: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) joints: vec4<u32>,
  @location(3) weights: vec4<f32>,
};

struct VSOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) nrm: vec3<f32>,
  @location(1) viewZ: f32,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
  let skin =
    in.weights.x * jointMats[in.joints.x] +
    in.weights.y * jointMats[in.joints.y] +
    in.weights.z * jointMats[in.joints.z] +
    in.weights.w * jointMats[in.joints.w];
  let worldPos = skin * vec4<f32>(in.pos, 1.0);
  let viewPos = cam.view * worldPos;
  var out: VSOut;
  out.clipPos = cam.proj * viewPos;
  // upper 3x3 is fine for normals under uniform scale (importer-border guarantee)
  out.nrm = mat3x3<f32>(skin[0].xyz, skin[1].xyz, skin[2].xyz) * in.nrm;
  out.viewZ = -viewPos.z;
  return out;
}

struct FSOut {
  @location(0) lit: vec4<f32>,
  @location(1) linDepth: vec4<f32>,
};

// Shade in linear, encode sRGB explicitly in this (final) pass; the rgba8unorm
// target then holds display-ready bytes and the PNG writes them verbatim.
fn srgbEncode(c: vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

@fragment
fn fs_main(in: VSOut) -> FSOut {
  let n = normalize(in.nrm);
  let ndl = max(dot(n, normalize(cam.lightDir.xyz)), 0.0);
  let albedo = vec3<f32>(0.55, 0.32, 0.18); // linear
  let ambient = 0.12;
  let shaded = albedo * (ambient + (1.0 - ambient) * ndl);
  let ld = clamp((in.viewZ - cam.params.x) / (cam.params.y - cam.params.x), 0.0, 1.0);
  var out: FSOut;
  out.lit = vec4<f32>(srgbEncode(shaded), 1.0);
  out.linDepth = vec4<f32>(ld, 0.0, 0.0, 1.0);
  return out;
}
