/**
 * The render orchestrator (P2-T1): canonical glb -> per-direction, per-frame AOV
 * PNGs + a throughput report, entirely headless. INTERNAL — the D-004 seam is
 * mod.ts; nothing here (device, textures, pixel buffers) crosses it.
 *
 * Structure follows the webgpu-headless-rendering skill: build the pipeline,
 * targets, bind group, and vertex/uniform/storage buffers ONCE; per frame only
 * update the camera + joint buffers and encode draw + copy; never await mapAsync
 * per frame (the ReadbackPool double-buffers). The camera is static within a
 * direction (constant per-clip framing + lighting law); only the pose animates.
 */
import {
  AOV_TARGETS,
  type FramingResult,
  type GpuContext,
  packCamera,
  type RenderJobSpec,
} from './contracts.ts';
import { solveFraming } from './camera.ts';
import {
  type AovTargets,
  createAovPassDescriptor,
  createAovPipeline,
  createAovTargets,
} from './aov.ts';
import {
  evalJointMatrices,
  jointScratch,
  loadSkinnedAsset,
  posedBounds,
  type SkinnedAsset,
} from './skinning.ts';
import { ReadbackPool } from './readback.ts';
import { encodeAov } from './png.ts';
import { buildThroughput, writeThroughput } from './throughput.ts';

/** Constant world-space direction TOWARD the light (constant per-clip lighting law). */
const LIGHT_DIR: readonly [number, number, number] = [0.4, 0.9, 0.5];

const bpp = AOV_TARGETS.map((t) => t.bpp);

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export interface RenderSummary {
  directions: number;
  frames: number;
  cellPx: { w: number; h: number };
  pivotPx: { x: number; y: number };
  passes: string[];
  framesDir: string;
  /** frames * directions * passes */
  pageCount: number;
}

export class Renderer {
  private constructor(
    private gpu: GpuContext,
    private asset: SkinnedAsset,
    private framing: FramingResult,
    private width: number,
    private height: number,
    private pipeline: GPURenderPipeline,
    private targets: AovTargets,
    private bindGroup: GPUBindGroup,
    private camBuf: GPUBuffer,
    private jointBuf: GPUBuffer,
    private vb: GPUBuffer[],
    private ib: GPUBuffer,
    private camData: Float32Array[],
    private scratch: { mats: Float32Array; worlds: Float32Array },
  ) {}

  static async create(
    gpu: GpuContext,
    asset: SkinnedAsset,
    framing: FramingResult,
    shaderSrc: string,
    width: number,
    height: number,
  ): Promise<Renderer> {
    const { device } = gpu;
    device.pushErrorScope('validation');

    const pipeline = await createAovPipeline(device, shaderSrc);
    const targets = createAovTargets(device, width, height);

    const mkBuf = (data: ArrayBufferView, usage: number): GPUBuffer => {
      const buf = device.createBuffer({
        size: Math.ceil(data.byteLength / 4) * 4,
        usage: usage | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, data as BufferSource);
      return buf;
    };
    const vb = [
      mkBuf(asset.positions, GPUBufferUsage.VERTEX),
      mkBuf(asset.normals, GPUBufferUsage.VERTEX),
      mkBuf(asset.joints, GPUBufferUsage.VERTEX),
      mkBuf(asset.weights, GPUBufferUsage.VERTEX),
    ];
    const ib = mkBuf(asset.indices, GPUBufferUsage.INDEX);

    const jointBuf = device.createBuffer({
      size: asset.jointCount * 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const camBuf = device.createBuffer({
      size: 160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: camBuf } },
        { binding: 1, resource: { buffer: jointBuf } },
      ],
    });

    const camData = framing.cameras.map((c) =>
      packCamera(c.view, c.proj, c.near, c.far, LIGHT_DIR)
    );

    const err = await device.popErrorScope();
    if (err) throw new Error(`renderer setup validation error: ${err.message}`);

    return new Renderer(
      gpu,
      asset,
      framing,
      width,
      height,
      pipeline,
      targets,
      bindGroup,
      camBuf,
      jointBuf,
      vb,
      ib,
      camData,
      jointScratch(asset),
    );
  }

  get directions(): number {
    return this.framing.cameras.length;
  }

  /**
   * Destroy every GPU resource this renderer owns. Call once, after the last
   * render has fully drained (all queued work done) — the shared device outlives
   * the renderer, so a per-job Renderer that never disposed would leak textures
   * and buffers across a batch of hundreds of characters.
   */
  dispose(): void {
    for (const t of this.targets.color) t.destroy();
    this.targets.depthStencil.destroy();
    for (const b of this.vb) b.destroy();
    this.ib.destroy();
    this.jointBuf.destroy();
    this.camBuf.destroy();
  }

  /** Encode one frame's draw into `encoder` after updating the camera+joint buffers. */
  private encodeFrame(encoder: GPUCommandEncoder, direction: number, frame: number): void {
    this.gpu.device.queue.writeBuffer(this.camBuf, 0, this.camData[direction] as BufferSource);
    evalJointMatrices(this.asset, frame, this.scratch.mats, this.scratch.worlds);
    this.gpu.device.queue.writeBuffer(this.jointBuf, 0, this.scratch.mats as BufferSource);

    const pass = encoder.beginRenderPass(createAovPassDescriptor(this.targets));
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    for (let i = 0; i < this.vb.length; i++) pass.setVertexBuffer(i, this.vb[i]);
    pass.setIndexBuffer(this.ib, 'uint32');
    pass.drawIndexed(this.asset.indices.length);
    pass.end();
  }

  /**
   * Render every direction x frame, writing one PNG per AOV under
   * `framesDir` and a throughput.json under `outDir`. Returns the summary +
   * throughput path. One ReadbackPool spans the whole job so readback stays
   * pipelined across directions.
   */
  async renderAll(
    outDir: string,
    frames: number,
  ): Promise<{ summary: RenderSummary; throughputPath: string }> {
    const framesDir = `${outDir}/frames`;
    await Deno.mkdir(framesDir, { recursive: true });

    const pool = new ReadbackPool(this.gpu.device, this.width, this.height, bpp);
    const total = this.directions * frames;

    const metrics = await pool.runBatch({
      frames: total,
      submitFrame: (g, slotBuffers) => {
        const direction = Math.floor(g / frames);
        const frame = g % frames;
        const encoder = this.gpu.device.createCommandEncoder();
        this.encodeFrame(encoder, direction, frame);
        for (let k = 0; k < AOV_TARGETS.length; k++) {
          encoder.copyTextureToBuffer(
            { texture: this.targets.color[k] },
            { buffer: slotBuffers[k], bytesPerRow: pool.paddedBPR[k] },
            { width: this.width, height: this.height },
          );
        }
        this.gpu.device.queue.submit([encoder.finish()]);
      },
      consume: async (g, planes) => {
        const direction = Math.floor(g / frames);
        const frame = g % frames;
        const tag = `d${pad(direction, 2)}_f${pad(frame, 3)}`;
        for (let k = 0; k < AOV_TARGETS.length; k++) {
          const png = encodeAov(planes[k], this.width, this.height, AOV_TARGETS[k].encode);
          await Deno.writeFile(`${framesDir}/${tag}_${AOV_TARGETS[k].pass}.png`, png);
        }
      },
    });

    const throughputPath = `${outDir}/throughput.json`;
    await writeThroughput(
      throughputPath,
      buildThroughput(metrics, {
        width: this.width,
        height: this.height,
        aovCount: AOV_TARGETS.length,
        adapter: this.gpu.adapterInfo,
      }),
    );

    const summary: RenderSummary = {
      directions: this.directions,
      frames,
      cellPx: { w: this.width, h: this.height },
      pivotPx: this.framing.pivotPx,
      passes: AOV_TARGETS.map((t) => t.pass),
      framesDir,
      pageCount: total * AOV_TARGETS.length,
    };
    return { summary, throughputPath };
  }

  /**
   * Render ONE direction/frame and return the five stripped AOV planes via the
   * padded-strip readback path. Used by tests: the double-render canary compares
   * two calls for byte-equality; the width-100 test compares against the
   * row-by-row reference below.
   */
  async capturePadded(direction: number, frame: number): Promise<Uint8Array[]> {
    const planes: Uint8Array[] = [];
    const pool = new ReadbackPool(this.gpu.device, this.width, this.height, bpp);
    await pool.runBatch({
      frames: 1,
      warmup: 0,
      submitFrame: (_g, slotBuffers) => {
        const encoder = this.gpu.device.createCommandEncoder();
        this.encodeFrame(encoder, direction, frame);
        for (let k = 0; k < AOV_TARGETS.length; k++) {
          encoder.copyTextureToBuffer(
            { texture: this.targets.color[k] },
            { buffer: slotBuffers[k], bytesPerRow: pool.paddedBPR[k] },
            { width: this.width, height: this.height },
          );
        }
        this.gpu.device.queue.submit([encoder.finish()]);
      },
      consume: (_g, p) => {
        for (const plane of p) planes.push(plane.slice());
      },
    });
    return planes;
  }

  /**
   * Reference readback for the width-100 strip test: copy each AOV one row at a
   * time (single-row copies need no bytesPerRow alignment), so the result needs
   * no padding math. Byte-identical output to capturePadded proves the strip.
   */
  async captureRowByRow(direction: number, frame: number): Promise<Uint8Array[]> {
    const device = this.gpu.device;
    const unpadded = bpp.map((b) => this.width * b);
    const bufs = unpadded.map((bpr) =>
      device.createBuffer({
        size: bpr * this.height,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
    );
    const encoder = device.createCommandEncoder();
    this.encodeFrame(encoder, direction, frame);
    for (let k = 0; k < AOV_TARGETS.length; k++) {
      for (let y = 0; y < this.height; y++) {
        encoder.copyTextureToBuffer(
          { texture: this.targets.color[k], origin: { x: 0, y, z: 0 } },
          { buffer: bufs[k], offset: y * unpadded[k] },
          { width: this.width, height: 1 },
        );
      }
    }
    device.queue.submit([encoder.finish()]);
    const planes: Uint8Array[] = [];
    for (const b of bufs) {
      await b.mapAsync(GPUMapMode.READ);
      planes.push(new Uint8Array(b.getMappedRange()).slice());
      b.unmap();
      b.destroy();
    }
    return planes;
  }
}

/** Load + set up a renderer for a spec (shared by the seam and tests). */
export async function makeRenderer(
  gpu: GpuContext,
  spec: Pick<RenderJobSpec, 'modelPath' | 'camera' | 'frames'>,
  shaderSrc: string,
): Promise<Renderer> {
  const asset = await loadSkinnedAsset(spec.modelPath);
  // frame the STABLE per-clip bounds (union over the posed frames), not the bind
  // pose — a rotating/moving silhouette sweeps outside the bind AABB (m6).
  const framing = solveFraming(spec.camera, posedBounds(asset, spec.frames));
  return Renderer.create(
    gpu,
    asset,
    framing,
    shaderSrc,
    spec.camera.cellPx.w,
    spec.camera.cellPx.h,
  );
}
