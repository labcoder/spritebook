// P2-T1 render shaders: WGSL skinning vertex shader + 5-output MRT fragment
// shader for the SpriteBook AOV pass. One render pass writes all five AOVs so
// they are geometrically identical by construction (webgpu-headless-rendering
// skill). Host/WGSL layout is the frozen interlock in contracts.ts — vertex
// locations 0-3, @group(0) bindings 0-1, Camera at 160 bytes.
//
// Color-space discipline: shade in LINEAR, apply the sRGB encode EXACTLY ONCE,
// only in the lit AOV. albedo/normal/depth/mask are data AOVs and stay linear.

struct Camera {
  view: mat4x4<f32>,   // @0
  proj: mat4x4<f32>,   // @64
  params: vec4<f32>,   // @128  x = near, y = far
  lightDir: vec4<f32>, // @144  xyz = normalized world-space direction TOWARD the light
};

@group(0) @binding(0) var<uniform> cam: Camera;
// Joint matrices live in a STORAGE buffer (skill: no uniform stride/size ceiling
// for large skeletons). One mat4x4<f32> per joint, column-major.
@group(0) @binding(1) var<storage, read> jointMats: array<mat4x4<f32>>;

struct VSIn {
  @location(0) pos: vec3<f32>,     // POSITION  float32x3
  @location(1) nrm: vec3<f32>,     // NORMAL    float32x3
  @location(2) joints: vec4<u32>,  // JOINTS_0  uint32x4 (importer upconverts u8/u16 -> u32)
  @location(3) weights: vec4<f32>, // WEIGHTS_0 float32x4
};

struct VSOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) nrm: vec3<f32>,
  // Positive view-space distance -viewZ, passed to the FS for linearization.
  @location(1) viewZ: f32,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
  // Blended skin matrix = Σ weight[k] * jointMats[joints[k]] over k = 0..3.
  let skin =
    in.weights.x * jointMats[in.joints.x] +
    in.weights.y * jointMats[in.joints.y] +
    in.weights.z * jointMats[in.joints.z] +
    in.weights.w * jointMats[in.joints.w];

  let worldPos = skin * vec4<f32>(in.pos, 1.0);
  let viewPos = cam.view * worldPos;

  var out: VSOut;
  out.clipPos = cam.proj * viewPos;
  // Upper-3x3 of the blended skin matrix is correct for normals under uniform
  // scale, which the importer border guarantees.
  out.nrm = mat3x3<f32>(skin[0].xyz, skin[1].xyz, skin[2].xyz) * in.nrm;
  // Camera looks down -Z, so viewPos.z is negative in front of the camera;
  // -viewPos.z is the positive distance the depth AOV linearizes against.
  out.viewZ = -viewPos.z;
  return out;
}

// FS output struct: @location(0..4) MUST match AOV_TARGETS order —
// lit, albedo, normal, depth, mask.
struct FSOut {
  @location(0) lit: vec4<f32>,    // rgba8unorm, sRGB-encoded, display-ready
  @location(1) albedo: vec4<f32>, // rgba8unorm, LINEAR base color (data AOV)
  @location(2) normal: vec4<f32>, // rgba8unorm, encoded n*0.5+0.5
  @location(3) depth: f32,        // r32float, linearized view depth in [0,1]
  @location(4) mask: u32,         // r32uint, object id (1 where drawn, 0 = empty)
};

// Shade in linear, sRGB-encode ONCE here (lit AOV only): the rgba8unorm target
// then holds display-ready bytes that the PNG writes verbatim.
fn srgbEncode(c: vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

@fragment
fn fs_main(in: VSOut) -> FSOut {
  let n = normalize(in.nrm);
  let ndl = max(dot(n, normalize(cam.lightDir.xyz)), 0.0);

  let albedoLinear = vec3<f32>(0.55, 0.32, 0.18); // linear base color
  let ambient = 0.12;
  let shaded = albedoLinear * (ambient + (1.0 - ambient) * ndl);

  let near = cam.params.x;
  let far = cam.params.y;
  // in.viewZ already holds the positive distance -viewZ; contract formula is
  // clamp((-viewZ - near)/(far - near), 0, 1).
  let ld = clamp((in.viewZ - near) / (far - near), 0.0, 1.0);

  var out: FSOut;
  out.lit = vec4<f32>(srgbEncode(shaded), 1.0);
  out.albedo = vec4<f32>(albedoLinear, 1.0);
  out.normal = vec4<f32>(n * 0.5 + 0.5, 1.0);
  out.depth = ld;
  out.mask = 1u;
  return out;
}
