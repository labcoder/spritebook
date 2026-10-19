---
name: webgpu-headless-rendering
description: Offscreen GPU rendering and pixel readback with WebGPU in Node/Dawn, for the core render module. Use this skill whenever writing or modifying anything that renders without a browser — the render module, render spikes, throughput benchmarks, AOV passes (lit/albedo/normal/depth/mask), skinned mesh drawing, or any script that creates a GPUDevice, renders to a texture, or reads pixels back to write PNGs. Consult it even for "simple" render scripts — the readback alignment and color-space rules here prevent the most common silent image-corruption bugs.
---

# Headless WebGPU rendering in Node/Dawn

The core renders headlessly through the pinned `webgpu` Dawn addon on app-owned Node. There is no
canvas or swapchain: render into textures, copy into aligned buffers and read back. Use the existing
`getGpu`/`tryGetGpu` path instead of constructing a parallel device manager.

## Runtime setup

- Use Node **24.22.0**, compiled package exports and `webgpu` **0.6.2**. `npm run build` prepares
  the native helpers, JavaScript and Windows Vulkan loader. No runtime compatibility shim is used.
- Select `SPRITEBOOK_GPU_BACKEND=vulkan` (Windows/Linux) or `metal` (macOS). Direct3D shader
  redistribution is not cleared. The legacy backend variable remains only a compatibility alias.
- Null adapters must skip explicitly in optional tests and fail when `SPRITEBOOK_REQUIRE_GPU=1`.
  Native-addon load errors always fail; do not disguise a missing DLL as absent GPU hardware.
- Always call `disposeGpu()` at entrypoint/test teardown. Destroying the device alone leaves Dawn's
  root alive and Node running. Proof scripts can use `node tools/run.mjs <script.ts> [args]`.
- Request the device with explicit `requiredLimits` you actually depend on (e.g.
  `maxColorAttachments` for MRT). Relying on defaults works on your machine and fails on the
  smallest supported GPU.

## Offscreen render targets

Create color targets with `GPUTextureUsage.RENDER_ATTACHMENT | COPY_SRC`, format per the color-space
rules below. Never look for `getCurrentTexture()` — it does not exist here.

## The readback rule (source of the classic bug)

`copyTextureToBuffer` requires `bytesPerRow` to be a multiple of 256. Widths whose row size is not
already aligned need padding — and you must strip that padding after mapping, or images come out
diagonally sheared.

```ts
const bytesPerPixel = 4;
const unpadded = width * bytesPerPixel;
const padded = Math.ceil(unpadded / 256) * 256;
const buf = device.createBuffer({
  size: padded * height,
  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
});
encoder.copyTextureToBuffer({ texture }, { buffer: buf, bytesPerRow: padded }, { width, height });
// after submit:
await buf.mapAsync(GPUMapMode.READ);
const src = new Uint8Array(buf.getMappedRange());
const pixels = new Uint8Array(unpadded * height);
for (let y = 0; y < height; y++) {
  pixels.set(src.subarray(y * padded, y * padded + unpadded), y * unpadded);
}
buf.unmap();
```

Misaligned `bytesPerRow` fails validation loudly; forgetting to strip padding fails _silently_. Test
at a width like 100 px (row = 400 bytes → padded 512) to catch both.

## Multi-pass AOVs

Use MRT — one render pass, multiple color attachments (`lit`, `albedo`, `normal`, `mask`), fragment
shader returning a struct with `@location(0..n)`. One pass keeps all AOVs geometrically identical by
construction.

Depth gotcha: `depth24plus` cannot be copied to a buffer. Do not fight this — keep the depth
attachment for z-testing only, and write **linearized depth to a color target** (`r16float` or
`r32float`) in the same MRT struct. That gives a readable, deterministic depth AOV on every backend.

## Color space discipline (pick once, repo-wide)

Shade in linear. The repo convention: render linear → apply sRGB encode explicitly in the final
composite pass → readback bytes are display-ready sRGB → PNG writes them verbatim. Do not mix this
with `rgba8unorm-srgb` auto-encoding targets in the same pipeline — double-encoding produces
washed-out sprites that "look almost right." Palette quantization happens _after_ the sRGB decision
(see the npr-sprite-stylization skill).

## WGSL buffer layout traps

- `vec3<f32>` aligns to 16 bytes. In uniform/storage structs, either pad explicitly or use `vec4`.
  Mismatched host/shader layout reads garbage without any error.
- Uniform buffers have stricter layout than storage buffers. Put joint matrices (skinning) in a
  **storage buffer** of `mat4x4<f32>` — no stride surprises, no size ceiling problems for large
  skeletons.
- Skinning: pull 4 joint indices + weights per vertex, blend matrices in the vertex shader. For
  normals, the upper 3×3 of the blended matrix is fine under uniform scale (which the importer
  border guarantees).

## Batch loop and throughput

- Build pipelines and bind groups once; per frame only update the joint/camera buffers and encode
  draw + copy.
- Do not `await onSubmittedWorkDone()` or `mapAsync` per frame — that serializes CPU↔GPU. Double- or
  triple-buffer readback buffers and resolve maps in order while later frames encode.
- Measure with `performance.now()` around submit→map for coarse numbers; use the `timestamp-query`
  feature when the adapter offers it. Report frames/sec and readback MB/s — the p0 pass bar is ≥5
  frames/sec aggregate with two passes at 128 px.

## Stability and diagnostics

- The wgpu-backed runtime can hard-panic the process on some invalid usage (e.g. touching a
  destroyed texture) instead of throwing a validation error. Treat GPU resource lifetimes with the
  same care as manual memory: never destroy a texture that any queued work references.
- Wrap setup in `device.pushErrorScope("validation")` / `popErrorScope()` in tests so validation
  issues surface as assertions, not mystery output.
- Handle `device.lost` — log the reason and fail the job as `retryable`.
- Determinism: same machine + driver → byte-stable output (assert it in tests as a nondeterminism
  canary). Across machines it is _not_ stable — never hash rendered pixels for caching (repo
  invariant: hash inputs).

## Writing images

Use `@spritebook/image` for the qualified native-zlib PNG writer and fast-png decoder, and Node's
filesystem API for bytes. Copy file buffers into fresh `Uint8Array`s when code depends on `.slice()`
copying or typed-array alignment. Node Buffer slicing is a view. The image package also owns the
PNG/JPEG ndarray boundary used by glTF transforms; do not add Sharp/libvips to application
resources.
