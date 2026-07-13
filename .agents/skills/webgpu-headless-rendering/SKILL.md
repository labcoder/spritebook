---
name: webgpu-headless-rendering
description: Offscreen GPU rendering and pixel readback with WebGPU in Deno, for the core render module. Use this skill whenever writing or modifying anything that renders without a browser — the render module, render spikes, throughput benchmarks, AOV passes (lit/albedo/normal/depth/mask), skinned mesh drawing, or any script that creates a GPUDevice, renders to a texture, or reads pixels back to write PNGs. Consult it even for "simple" render scripts — the readback alignment and color-space rules here prevent the most common silent image-corruption bugs.
---

# Headless WebGPU rendering in Deno

Deno's WebGPU implementation is headless by design: there is no canvas and no swapchain. You render
into textures you create, then copy them to buffers and read them back. That model is exactly right
for this repo's batch renderer — embrace it rather than simulating a browser.

## Runtime setup

- Enable the API: add `"webgpu"` to the `unstable` array in `deno.json` (or run with
  `--unstable-webgpu`). The API is spec-shaped but flag-gated in Deno.
- Force a specific native backend for reproducibility or debugging with the `DENO_WEBGPU_BACKEND`
  env var (`vulkan`, `metal`, `dx12`). Pin it in CI so failures are comparable.
- Always handle the null adapter:
  `const adapter = await navigator.gpu.requestAdapter(); if (!adapter) fail with a message naming DENO_WEBGPU_BACKEND and driver hints.`
  Log adapter info and feature list in every diagnostic path — half of "renderer is broken" reports
  are driver situations.
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

`npm:fast-png` encodes RGBA in pure JS/WASM and works in Deno; write with `Deno.writeFile` (needs
`--allow-write`). Study `denoland/webgpu-examples` for the canonical headless capture→buffer→PNG
pattern.
