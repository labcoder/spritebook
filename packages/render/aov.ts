/**
 * GPU resource construction for the 5-AOV MRT pass (P2-T1). Builds the pipeline,
 * offscreen textures, and render-pass descriptor against the FROZEN interlocks in
 * contracts.ts (AOV_TARGETS order/formats, the vertex layout, the 160-byte Camera).
 *
 * INTERNAL: nothing here crosses the D-004 seam (mod.ts speaks only file paths +
 * JobEvents). The renderer imports these directly; they are never re-exported.
 *
 * ACTIVE PATH: single-pass — all five color attachments in ONE render pass, which
 * keeps every AOV geometrically identical by construction (webgpu-headless-rendering
 * skill). Validated on the real device (RTX 3090 / Vulkan, Deno 2.9.2): 5 attachments
 * create + draw + read back with no validation error, at exactly 32 bytes/sample (the
 * default maxColorAttachmentBytesPerSample floor — see the note on bytesPerSample below).
 * No 2-pass fallback is needed on this hardware.
 *
 * bytesPerSample note: the naive sum is 4*5 = 20 B, but WebGPU's
 * maxColorAttachmentBytesPerSample charges rgba8unorm at 8 B each (not 4) and r32 at
 * 4 B, so these five sum to 8+8+8+4+4 = 32 B — exactly the default limit. (Every cost
 * is a multiple of the 4-byte max alignment, so no padding is ever inserted and any
 * permutation also totals 32 — the budget does not constrain the order.) The order is
 * load-bearing because AOV_TARGETS is the single source of truth tying the FS
 * @location(0..4) outputs to the pipeline targets, textures, readback, and PNG
 * encoders — reordering silently mismatches AOV identity.
 */
import { AOV_TARGETS } from './contracts.ts';

/** depth24plus is z-test only and is NOT copyable — the readable depth AOV is r32float. */
export const DEPTH_STENCIL_FORMAT: GPUTextureFormat = 'depth24plus';

/**
 * The four vertex buffers, one per attribute, in shaderLocation order — the frozen
 * host⇄WGSL interlock (contracts.ts). JOINTS_0 is uint32x4 (the importer upconverts
 * u8/u16 joint indices to u32 so the storage-buffer index type is uniform).
 */
export const VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout[] = [
  { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
  { arrayStride: 16, attributes: [{ shaderLocation: 2, offset: 0, format: 'uint32x4' }] },
  { arrayStride: 16, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] },
];

/**
 * Per-attachment clear values in AOV_TARGETS order. lit/albedo/normal clear to
 * transparent black (undrawn texels read 0); the depth AOV clears to r=1 (far); the
 * mask clears to 0 (empty object id).
 */
const AOV_CLEAR_VALUES: readonly GPUColor[] = AOV_TARGETS.map((t): GPUColor => {
  switch (t.pass) {
    case 'depth':
      return { r: 1, g: 0, b: 0, a: 1 };
    case 'mask':
      return { r: 0, g: 0, b: 0, a: 0 };
    default:
      return { r: 0, g: 0, b: 0, a: 0 };
  }
});

/**
 * Create the single-pass MRT pipeline: layout 'auto', the four vertex buffers above,
 * the five color targets from AOV_TARGETS (order + formats), and depth24plus for
 * z-testing only. Validation is scoped so a bad pipeline throws here instead of
 * surfacing as mystery output later (skill rule). Async because popErrorScope resolves
 * asynchronously.
 */
export async function createAovPipeline(
  device: GPUDevice,
  shaderSrc: string,
): Promise<GPURenderPipeline> {
  const module = device.createShaderModule({ code: shaderSrc, label: 'aov-shaders' });
  device.pushErrorScope('validation');
  const pipeline = device.createRenderPipeline({
    label: 'aov-mrt-pipeline',
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: VERTEX_BUFFER_LAYOUT,
    },
    fragment: {
      module,
      entryPoint: 'fs_main',
      // Formats + order straight from the frozen contract → FS @location(0..4).
      targets: AOV_TARGETS.map((t): GPUColorTargetState => ({ format: t.format })),
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      format: DEPTH_STENCIL_FORMAT,
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
  });
  const err = await device.popErrorScope();
  if (err) throw new Error(`aov pipeline validation error: ${err.message}`);
  return pipeline;
}

/** The offscreen render targets for one AOV pass. */
export interface AovTargets {
  readonly width: number;
  readonly height: number;
  /** lit rgba8unorm — sRGB-encoded, display-ready. */
  readonly lit: GPUTexture;
  /** albedo rgba8unorm — linear base color (data AOV). */
  readonly albedo: GPUTexture;
  /** normal rgba8unorm — encoded n*0.5+0.5. */
  readonly normal: GPUTexture;
  /** depth r32float — linearized view depth in [0,1]. */
  readonly depth: GPUTexture;
  /** mask r32uint — object id (1 where drawn, 0 = empty). */
  readonly mask: GPUTexture;
  /** depth24plus — z-test attachment only; never copied (not copyable). */
  readonly depthStencil: GPUTexture;
  /** The five color AOV textures in AOV_TARGETS order, for readback iteration. */
  readonly color: readonly GPUTexture[];
}

/**
 * Create the five color AOV textures (RENDER_ATTACHMENT | COPY_SRC, so they can be
 * copied to a readback buffer) plus the depth24plus z-test texture (RENDER_ATTACHMENT
 * only). Formats/order come from AOV_TARGETS, so the named handles and the `color`
 * array are guaranteed to match the contract and the FS output locations.
 */
export function createAovTargets(
  device: GPUDevice,
  width: number,
  height: number,
): AovTargets {
  const size = { width, height };
  const colorUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
  const color = AOV_TARGETS.map((t) =>
    device.createTexture({ size, format: t.format, usage: colorUsage, label: `aov-${t.pass}` })
  );
  const [lit, albedo, normal, depth, mask] = color;
  const depthStencil = device.createTexture({
    size,
    format: DEPTH_STENCIL_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
    label: 'aov-depth24plus',
  });
  return { width, height, lit, albedo, normal, depth, mask, depthStencil, color };
}

/**
 * Build the render-pass descriptor for one AOV pass: five color attachments (loadOp
 * 'clear' → the AOV clear values above, storeOp 'store') plus the depth attachment
 * (depthClearValue 1, cleared and stored). A fresh descriptor with fresh views per
 * call — createView is cheap and this keeps the helper stateless.
 */
export function createAovPassDescriptor(targets: AovTargets): GPURenderPassDescriptor {
  const colorAttachments: GPURenderPassColorAttachment[] = targets.color.map((texture, i) => ({
    view: texture.createView(),
    clearValue: AOV_CLEAR_VALUES[i],
    loadOp: 'clear',
    storeOp: 'store',
  }));
  return {
    label: 'aov-pass',
    colorAttachments,
    depthStencilAttachment: {
      view: targets.depthStencil.createView(),
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
  };
}
