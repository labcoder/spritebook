// P0-T2: headless MRT renderer with double-buffered readback.
// Discipline (webgpu-headless-rendering skill): allocate everything up front,
// destroy nothing until the last map resolves, never await mapAsync per frame,
// pad bytesPerRow to 256 and strip after mapping.

import { evalJointMatrices, jointScratch, type SpikeAsset } from './asset.ts';
import { mat4LookAt, mat4Perspective } from './math.ts';

export interface GPUContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  adapterInfo: Record<string, unknown>;
  features: string[];
  lostInfo: { reason: string; message: string } | null;
}

export async function initGPU(): Promise<GPUContext> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    const backend = Deno.env.get('DENO_WEBGPU_BACKEND') ?? '(unset)';
    throw new Error(
      `No WebGPU adapter. DENO_WEBGPU_BACKEND=${backend}. ` +
        `Check GPU drivers; try DENO_WEBGPU_BACKEND=vulkan or dx12.`,
    );
  }
  // adapter.info properties are prototype getters — JSON.stringify shows {}; walk them.
  const adapterInfo: Record<string, unknown> = {};
  for (
    let p = Object.getPrototypeOf(adapter.info);
    p && p !== Object.prototype;
    p = Object.getPrototypeOf(p)
  ) {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (k === 'constructor') continue;
      try {
        const v = (adapter.info as unknown as Record<string, unknown>)[k];
        if (typeof v !== 'function' && v !== undefined && v !== '') adapterInfo[k] = v;
      } catch { /* getter threw — skip */ }
    }
  }
  const device = await adapter.requestDevice({
    // request what we depend on rather than trusting defaults (skill rule);
    // 2 attachments is within every adapter's floor of 4, but be explicit.
    requiredLimits: { maxColorAttachments: 4 },
  });
  const ctx: GPUContext = {
    adapter,
    device,
    adapterInfo,
    features: [...device.features].sort(),
    lostInfo: null,
  };
  device.lost.then((info) => {
    ctx.lostInfo = { reason: String(info.reason), message: info.message };
    console.error(`DEVICE LOST (retryable): ${info.reason} — ${info.message}`);
  });
  return ctx;
}

export interface BatchMetrics {
  frames: number;
  wallMs: number;
  fps: number;
  mapWaitMs: number;
  consumeMs: number;
  unpaddedBytesPerFrame: number;
  paddedBytesPerFrame: number;
  readbackMBps: number; // unpadded bytes (honest), aggregate over wall time
}

interface Slot {
  lit: GPUBuffer;
  dep: GPUBuffer;
  frame: number;
  mapped: Promise<unknown> | null;
}

export type Consume = (frame: number, lit: Uint8Array, dep: Uint8Array) => void | Promise<void>;

export class SpikeRenderer {
  readonly width: number;
  readonly height: number;
  readonly paddedBPR: number;
  readonly unpaddedBPR: number;

  private device: GPUDevice;
  private asset: SpikeAsset;
  private pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup;
  private litTex: GPUTexture;
  private depColorTex: GPUTexture;
  private depthTex: GPUTexture;
  private jointBuf: GPUBuffer;
  private camBuf: GPUBuffer;
  private vbPos: GPUBuffer;
  private vbNrm: GPUBuffer;
  private vbJoints: GPUBuffer;
  private vbWeights: GPUBuffer;
  private ib: GPUBuffer;
  private scratch: { mats: Float32Array; worlds: Float32Array };

  constructor(
    device: GPUDevice,
    asset: SpikeAsset,
    shaderSrc: string,
    width: number,
    height: number,
  ) {
    this.device = device;
    this.asset = asset;
    this.width = width;
    this.height = height;
    this.unpaddedBPR = width * 4;
    this.paddedBPR = Math.ceil(this.unpaddedBPR / 256) * 256;
    this.scratch = jointScratch(asset);

    const mkVB = (data: Float32Array | Uint8Array | Uint16Array, usage: number) => {
      const buf = device.createBuffer({
        size: Math.ceil(data.byteLength / 4) * 4,
        usage: usage | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, data as unknown as BufferSource);
      return buf;
    };
    this.vbPos = mkVB(asset.positions, GPUBufferUsage.VERTEX);
    this.vbNrm = mkVB(asset.normals, GPUBufferUsage.VERTEX);
    this.vbJoints = mkVB(asset.joints, GPUBufferUsage.VERTEX);
    this.vbWeights = mkVB(asset.weights, GPUBufferUsage.VERTEX);
    this.ib = mkVB(asset.indices, GPUBufferUsage.INDEX);

    this.jointBuf = device.createBuffer({
      size: asset.jointCount * 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // camera: static per renderer; near/far chosen to bracket the column
    const near = 0.5, far = 8.0;
    const view = mat4LookAt([2.0, 1.9, 2.8], [0, 1.0, 0], [0, 1, 0]);
    const proj = mat4Perspective((40 * Math.PI) / 180, width / height, near, far);
    const camData = new Float32Array(40); // 2 mat4 + 2 vec4
    camData.set(view, 0);
    camData.set(proj, 16);
    camData.set([near, far, 0, 0], 32);
    const light: [number, number, number] = [0.5, 0.8, 0.6];
    const ll = Math.hypot(...light);
    camData.set([light[0] / ll, light[1] / ll, light[2] / ll, 0], 36);
    this.camBuf = device.createBuffer({
      size: camData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.camBuf, 0, camData);

    const module = device.createShaderModule({ code: shaderSrc });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          { arrayStride: 4, attributes: [{ shaderLocation: 2, offset: 0, format: 'uint8x4' }] },
          { arrayStride: 16, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba8unorm' }, { format: 'r32float' }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.camBuf } },
        { binding: 1, resource: { buffer: this.jointBuf } },
      ],
    });

    const size = { width, height };
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
    this.litTex = device.createTexture({ size, format: 'rgba8unorm', usage });
    this.depColorTex = device.createTexture({ size, format: 'r32float', usage });
    this.depthTex = device.createTexture({
      size,
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private encodeRenderPass(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.litTex.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
        {
          view: this.depColorTex.createView(),
          clearValue: { r: 1, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTex.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vbPos);
    pass.setVertexBuffer(1, this.vbNrm);
    pass.setVertexBuffer(2, this.vbJoints);
    pass.setVertexBuffer(3, this.vbWeights);
    pass.setIndexBuffer(this.ib, 'uint16');
    pass.drawIndexed(this.asset.indices.length);
    pass.end();
  }

  /** queue.writeBuffer + render pass + copy both attachments into slot buffers; submit + mapAsync. */
  private submitFrame(frame: number, slot: Slot): void {
    evalJointMatrices(this.asset, frame, this.scratch.mats, this.scratch.worlds);
    this.device.queue.writeBuffer(this.jointBuf, 0, this.scratch.mats);
    const encoder = this.device.createCommandEncoder();
    this.encodeRenderPass(encoder);
    const extent = { width: this.width, height: this.height };
    encoder.copyTextureToBuffer(
      { texture: this.litTex },
      { buffer: slot.lit, bytesPerRow: this.paddedBPR },
      extent,
    );
    encoder.copyTextureToBuffer(
      { texture: this.depColorTex },
      { buffer: slot.dep, bytesPerRow: this.paddedBPR },
      extent,
    );
    this.device.queue.submit([encoder.finish()]);
    slot.frame = frame;
    slot.mapped = Promise.all([
      slot.lit.mapAsync(GPUMapMode.READ),
      slot.dep.mapAsync(GPUMapMode.READ),
    ]);
  }

  private stripInto(buf: GPUBuffer, out: Uint8Array): void {
    const src = new Uint8Array(buf.getMappedRange());
    if (this.paddedBPR === this.unpaddedBPR) {
      out.set(src.subarray(0, out.length));
    } else {
      for (let y = 0; y < this.height; y++) {
        out.set(
          src.subarray(y * this.paddedBPR, y * this.paddedBPR + this.unpaddedBPR),
          y * this.unpaddedBPR,
        );
      }
    }
    buf.unmap();
  }

  private makeSlot(): Slot {
    const size = this.paddedBPR * this.height;
    const usage = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
    return {
      lit: this.device.createBuffer({ size, usage }),
      dep: this.device.createBuffer({ size, usage }),
      frame: -1,
      mapped: null,
    };
  }

  /**
   * Render frames [firstFrame, firstFrame+frames) with a pool of `poolSize`
   * readback slots. `consume` runs on the CPU after each frame's pixels are
   * stripped (PNG encode / hashing / writes) and is included in wall time.
   */
  async runBatch(opts: {
    frames: number;
    firstFrame?: number;
    warmup?: number;
    poolSize?: number;
    consume?: Consume;
    onFrameDone?: (frameOrdinal: number) => void;
  }): Promise<BatchMetrics> {
    const { frames, firstFrame = 0, warmup = 3, poolSize = 3, consume, onFrameDone } = opts;
    const slots: Slot[] = Array.from({ length: poolSize }, () => this.makeSlot());
    const litPixels = new Uint8Array(this.unpaddedBPR * this.height);
    const depPixels = new Uint8Array(this.unpaddedBPR * this.height);

    let mapWaitMs = 0;
    let consumeMs = 0;
    let done = 0;

    const resolveSlot = async (slot: Slot, timed: boolean) => {
      const t0 = performance.now();
      await slot.mapped;
      const t1 = performance.now();
      this.stripInto(slot.lit, litPixels);
      this.stripInto(slot.dep, depPixels);
      slot.mapped = null;
      if (timed && consume) await consume(slot.frame, litPixels, depPixels);
      const t2 = performance.now();
      if (timed) {
        mapWaitMs += t1 - t0;
        consumeMs += t2 - t1;
        onFrameDone?.(done++);
      }
    };

    // warmup (pipeline/driver lazy compile) — fully drained, untimed
    for (let w = 0; w < warmup; w++) {
      this.submitFrame(firstFrame, slots[0]);
      await resolveSlot(slots[0], false);
    }

    const free: Slot[] = [...slots];
    const inFlight: Slot[] = [];
    const tStart = performance.now();
    for (let f = 0; f < frames; f++) {
      let slot: Slot;
      if (free.length > 0) slot = free.pop()!;
      else {
        slot = inFlight.shift()!;
        await resolveSlot(slot, true);
      }
      this.submitFrame(firstFrame + f, slot);
      inFlight.push(slot);
    }
    while (inFlight.length > 0) await resolveSlot(inFlight.shift()!, true);
    const wallMs = performance.now() - tStart;

    for (const s of slots) {
      s.lit.destroy();
      s.dep.destroy();
    }

    const unpadded = this.unpaddedBPR * this.height * 2; // both attachments
    const padded = this.paddedBPR * this.height * 2;
    return {
      frames,
      wallMs,
      fps: frames / (wallMs / 1000),
      mapWaitMs,
      consumeMs,
      unpaddedBytesPerFrame: unpadded,
      paddedBytesPerFrame: padded,
      readbackMBps: (unpadded * frames) / (wallMs / 1000) / (1024 * 1024),
    };
  }

  /** Render one frame; read the lit target back via the padded+strip path. */
  async renderSinglePadded(frame: number): Promise<Uint8Array> {
    const slot = this.makeSlot();
    this.submitFrame(frame, slot);
    await slot.mapped;
    const out = new Uint8Array(this.unpaddedBPR * this.height);
    this.stripInto(slot.lit, out);
    slot.dep.unmap();
    slot.lit.destroy();
    slot.dep.destroy();
    return out;
  }

  /**
   * Reference path for the width-100 shear test: copy the lit target one row at
   * a time (bytesPerRow is not required for single-row copies), so the result
   * needs no padding math at all. Byte-identical output proves the strip logic.
   */
  async renderSingleRowByRow(frame: number): Promise<Uint8Array> {
    evalJointMatrices(this.asset, frame, this.scratch.mats, this.scratch.worlds);
    this.device.queue.writeBuffer(this.jointBuf, 0, this.scratch.mats);
    const buf = this.device.createBuffer({
      size: this.unpaddedBPR * this.height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = this.device.createCommandEncoder();
    this.encodeRenderPass(encoder);
    for (let y = 0; y < this.height; y++) {
      encoder.copyTextureToBuffer(
        { texture: this.litTex, origin: { x: 0, y, z: 0 } },
        { buffer: buf, offset: y * this.unpaddedBPR },
        { width: this.width, height: 1 },
      );
    }
    this.device.queue.submit([encoder.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const out = new Uint8Array(buf.getMappedRange()).slice();
    buf.unmap();
    buf.destroy();
    return out;
  }
}
