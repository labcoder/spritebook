import { promises as fs } from 'node:fs';
import type { Lighting } from '@spritebook/schema';
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
  evalPosesMatrices,
  jointScratch,
  loadSkinnedAsset,
  posedBounds,
  posedBoundsFromPoses,
  type PoseMode,
  type SkinnedAsset,
} from './skinning.ts';
import { mapPosesJoints, readPoses } from './poses.ts';

/** A loaded poses artifact, mapped onto the asset's joints (pose === 'clip'). */
export interface ClipPoses {
  data: Float32Array;
  map: Int32Array;
  jointsPerFrame: number;
}
import { align256, ReadbackPool } from './readback.ts';
import { encodeAov } from './png.ts';
import { buildThroughput, writeThroughput } from './throughput.ts';
import { settleGpuQueue } from './gpu.ts';

/**
 * THE LIGHT RIG. One key direction plus an ambient floor, constant in world
 * space for every direction and every frame — that constancy is the per-clip
 * lighting law, and it is why a sprite's shading does not crawl as it turns.
 *
 * Exported because it is measurable: `lighting_test.ts` predicts the lit AOV in
 * closed form from these two numbers, so a change here has to be a deliberate
 * one with a render behind it.
 */
export const LIGHT_DIR: readonly [number, number, number] = [0.4, 0.9, 0.5];

/**
 * The floor a surface facing away from the key still receives, in LINEAR light.
 *
 * The key is mostly OVERHEAD, so a surface pointing at the camera — the ones a
 * sprite is made of — catches it at ndl 0.4527. At the 0.12 this shipped with,
 * that shaded to 0.518 of albedo and cost a white camera-facing texel 26% of
 * its value; averaged over a body (Lambert's mean over a sphere is 0.25) it was
 * a 40% drop, and it was the whole of the "every sheet reads darker than its
 * reference" gap. Never a bug: LIGHTING-REPORT.md measured the lit AOV against
 * this exact formula and ruled out a double sRGB encode and a missing term.
 *
 * 0.30 because it is the only knob that MOVES the result. Measured across three
 * subjects, raising ambient lifted mean value ~20% while aiming the key at the
 * camera lifted it 2% — the adaptive palette re-normalizes, so a uniform
 * brightening is quantized straight back out, and what ambient changes is the
 * SHAPE of the distribution: it raises the dark tail without moving the top.
 *
 * The cost, recorded because it is real: the outline is `palette-dark`, so
 * lifting the floor lifts the outline too. Princess (pastel, lineless) goes
 * from an outline at V 0.094 to one at 0.161 and ends up with no texel below
 * 0.15 at all; her outline-to-body contrast falls 2.2x -> 1.7x. Still legible,
 * and the trade was made deliberately.
 */
export const AMBIENT = 0.30;

/**
 * Which frame the key light is FIXED in (B3, C-WAVE.md).
 *
 * 'world': one world-space direction for every view — physically consistent
 * turntable lighting, and the reason back-facing directions render dark (the
 * lit side faces away from the camera).
 * 'camera': the key rotates with each direction's camera, so all 8 directions
 * read identically — the shipped-game convention (Dead Cells, impostor
 * pipelines). Still constant per direction per clip, so the temporal
 * stability law holds unchanged.
 *
 * The default is 'camera', picked from the B3 sheets (three subjects, both
 * options, 8 genuine directions): under 'world' the back rows lose the
 * character — bulma's mean V spans 0.174 across directions and the pink
 * shirt reads mud from behind; under 'camera' the spread drops to 0.072 and
 * every facing reads as the same sprite, which is what sheet consumers
 * assume. The one counter-signal (mermaid's spread RISING 0.026 → 0.125)
 * turned out to be albedo, not lighting: her back hair is genuinely the
 * brighter mass, and 'world' was cancelling that against the lighting
 * falloff. 'world' stays reachable via `bake --light-frame world`.
 */
export type LightFrame = 'world' | 'camera';
export const DEFAULT_LIGHT_FRAME: LightFrame = 'camera';

/** LIGHT_DIR as each direction camera sees it, per the frame choice. */
export function lightDirFor(
  frame: LightFrame,
  yawDeg: number,
  direction = LIGHT_DIR,
): [number, number, number] {
  if (frame === 'world') return [direction[0], direction[1], direction[2]];
  // rotate the key about +Y by the camera's yaw, so the light-to-camera
  // relation at direction 0 is reproduced at every direction
  const r = (yawDeg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [
    c * direction[0] + s * direction[2],
    direction[1],
    -s * direction[0] + c * direction[2],
  ];
}

const bpp = AOV_TARGETS.map((t) => t.bpp);

/** Refuse unsupported capture sizes before allocating targets or readback buffers. */
export function assertRenderSize(
  limits: Pick<GPUSupportedLimits, 'maxTextureDimension2D' | 'maxBufferSize'>,
  width: number,
  height: number,
): void {
  const readbackBytes = align256(width * Math.max(...bpp)) * height;
  if (
    width > limits.maxTextureDimension2D || height > limits.maxTextureDimension2D ||
    readbackBytes > limits.maxBufferSize
  ) {
    throw new Error(
      `Capture ${width} × ${height} exceeds this GPU's render limits ` +
        `(${limits.maxTextureDimension2D}px per side; ${limits.maxBufferSize} bytes per buffer). ` +
        'Reduce supersampling or output size and try again.',
    );
  }
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

const halfF32 = new Float32Array(1);
const halfU32 = new Uint32Array(halfF32.buffer);

/**
 * f32 -> IEEE-754 half (the bits `rgba16float` wants). Only the finite,
 * normal range matters here — these are material factors in [0,1], where the
 * worst-case error is ~5e-4 relative, two orders below the 8-bit output
 * resolution the value ends up in.
 */
function toHalf(value: number): number {
  halfF32[0] = value;
  const x = halfU32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // Inf / NaN
  exp = exp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7c00; // overflow -> Inf
  if (exp <= 0) {
    if (exp < -10) return sign; // underflow -> signed zero
    mant |= 0x800000;
    const shift = 14 - exp;
    const half = (mant + (1 << (shift - 1))) >>> shift;
    return sign | half;
  }
  // round half to even, and let a mantissa carry bump the exponent
  const rounded = mant + 0x1000 + ((mant >>> 13) & 1);
  if (rounded & 0x800000) return sign | ((exp + 1) << 10);
  return sign | (exp << 10) | (rounded >>> 13);
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
    private baseColorTex: GPUTexture[],
    private matBufs: GPUBuffer[],
    /** one @group(1) bind group per MATERIAL, bound per primitive range */
    private texBindGroups: GPUBindGroup[],
    private pose: PoseMode,
    private clipPoses?: ClipPoses,
    /** direction indices to draw; undefined = all of them */
    private subset?: number[],
  ) {}

  static async create(
    gpu: GpuContext,
    asset: SkinnedAsset,
    framing: FramingResult,
    shaderSrc: string,
    width: number,
    height: number,
    pose: PoseMode = 'turntable',
    clipPoses?: ClipPoses,
    subset?: number[],
    lightFrame: LightFrame = DEFAULT_LIGHT_FRAME,
    lighting?: Lighting,
  ): Promise<Renderer> {
    const { device } = gpu;
    assertRenderSize(device.limits, width, height);
    device.pushErrorScope('validation');
    let scopeOpen = true;
    const allocated: (GPUBuffer | GPUTexture)[] = [];
    const createBuffer = (descriptor: GPUBufferDescriptor) => {
      const buffer = device.createBuffer(descriptor);
      allocated.push(buffer);
      return buffer;
    };
    try {
      const pipeline = await createAovPipeline(device, shaderSrc);
      const targets = createAovTargets(device, width, height);
      allocated.push(...targets.color, targets.depthStencil);

      const mkBuf = (data: ArrayBufferView, usage: number): GPUBuffer => {
        const buf = createBuffer({
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
        mkBuf(asset.uvs, GPUBufferUsage.VERTEX),
      ];
      const ib = mkBuf(asset.indices, GPUBufferUsage.INDEX);

      // Base color sources, uploaded in the format that keeps each one HONEST.
      // An image is authored in sRGB, so rgba8unorm-srgb lets the hardware decode
      // it to linear for free. A material FACTOR is already a linear number and
      // gets rgba16float, because sRGB-encoding it into 8 bits does not round
      // trip (0.55 -> byte 196 -> 0.552011) and that error reaches the albedo
      // AOV. Both bind as texture_2d<f32>, so the shader and the frozen
      // interlock see no difference.
      const sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
      const baseColorTex = asset.textures.map((t, i) => {
        const image = t.kind === 'image';
        const w = image ? t.width : 1;
        const h = image ? t.height : 1;
        const tex = device.createTexture({
          label: `base-color-${i}`,
          size: { width: w, height: h },
          format: image ? 'rgba8unorm-srgb' : 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        allocated.push(tex);
        const data: BufferSource = image
          ? t.rgba as BufferSource
          : Uint16Array.from(t.linear, toHalf) as BufferSource;
        device.queue.writeTexture(
          { texture: tex },
          data,
          { bytesPerRow: w * (image ? 4 : 8), rowsPerImage: h },
          { width: w, height: h },
        );
        return tex;
      });

      const jointBuf = createBuffer({
        size: asset.jointCount * 64,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const camBuf = createBuffer({
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
      // One uniform + one bind group PER MATERIAL, because base color is
      // `factor x texture` and two materials can share a texture with different
      // factors (contracts.ts, THE MATERIAL CONTRACT). Std140: vec4 factor at 0,
      // then cutoff and mode as floats at 16 — 32 bytes, the minimum a uniform
      // binding can be without padding games.
      const matBufs = asset.materials.map((m, i) => {
        const buf = createBuffer({
          label: `material-${i}`,
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const data = new Float32Array(8);
        data.set(m.factor, 0);
        data[4] = m.alphaCutoff;
        data[5] = m.alphaMode === 'MASK' ? 1 : 0;
        device.queue.writeBuffer(buf, 0, data as BufferSource);
        return buf;
      });
      const texBindGroups = asset.materials.map((m, i) =>
        device.createBindGroup({
          label: `material-bg-${i}`,
          layout: pipeline.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: baseColorTex[m.texture].createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: matBufs[i] } },
          ],
        })
      );

      const camData = framing.cameras.map((c) =>
        packCamera(
          c.view,
          c.proj,
          c.near,
          c.far,
          lightDirFor(lightFrame, c.yawDeg, lighting?.direction),
          lighting?.ambient ?? AMBIENT,
        )
      );

      const checked = device.popErrorScope();
      scopeOpen = false;
      const err = await checked;
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
        baseColorTex,
        matBufs,
        texBindGroups,
        pose,
        clipPoses,
        subset,
      );
    } catch (error) {
      if (scopeOpen) {
        await Promise.resolve().then(() => device.popErrorScope()).catch(() => {});
      }
      // Uploads may already be queued when a later material or binding fails validation.
      await settleGpuQueue(device);
      for (const resource of allocated) {
        try {
          resource.destroy();
        } catch { /* keep the original setup failure */ }
      }
      throw error;
    }
  }

  /**
   * The direction INDICES this renderer will draw, in order. Normally every
   * direction; a subset when the caller only needs some (D-008 mirroring).
   */
  get directionList(): number[] {
    return this.subset ?? this.framing.cameras.map((_, i) => i);
  }

  get directions(): number {
    return this.directionList.length;
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
    for (const t of this.baseColorTex) t.destroy();
    for (const b of this.matBufs) b.destroy();
    this.ib.destroy();
    this.jointBuf.destroy();
    this.camBuf.destroy();
  }

  /** Encode one frame's draw into `encoder` after updating the camera+joint buffers. */
  private encodeFrame(encoder: GPUCommandEncoder, direction: number, frame: number): void {
    this.gpu.device.queue.writeBuffer(this.camBuf, 0, this.camData[direction] as BufferSource);
    if (this.pose === 'clip' && this.clipPoses) {
      const cp = this.clipPoses;
      evalPosesMatrices(
        this.asset,
        cp.data,
        cp.map,
        cp.jointsPerFrame,
        frame,
        this.scratch.mats,
        this.scratch.worlds,
      );
    } else {
      evalJointMatrices(this.asset, frame, this.scratch.mats, this.scratch.worlds, this.pose);
    }
    this.gpu.device.queue.writeBuffer(this.jointBuf, 0, this.scratch.mats as BufferSource);

    const pass = encoder.beginRenderPass(createAovPassDescriptor(this.targets));
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    for (let i = 0; i < this.vb.length; i++) pass.setVertexBuffer(i, this.vb[i]);
    pass.setIndexBuffer(this.ib, 'uint32');
    // one draw per primitive range, each with its own base color texture
    for (const r of this.asset.ranges) {
      pass.setBindGroup(1, this.texBindGroups[r.material]);
      pass.drawIndexed(r.indexCount, 1, r.firstIndex);
    }
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
    frameIndex?: number,
  ): Promise<{ summary: RenderSummary; throughputPath: string }> {
    if (
      frameIndex !== undefined &&
      (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= frames)
    ) {
      throw new Error(`Preview frame must be between 0 and ${frames - 1}`);
    }
    const framesDir = `${outDir}/frames`;
    await fs.mkdir(framesDir, { recursive: true });

    const pool = new ReadbackPool(this.gpu.device, this.width, this.height, bpp);
    // the frames are laid out subset-major: g -> (list[g/frames], g%frames),
    // so the FILE NAMES keep the true direction index and a mirrored bake
    // drops straight into the same naming the packer already reads
    const list = this.directionList;
    const count = frameIndex === undefined ? frames : 1;
    const total = list.length * count;

    const metrics = await pool.runBatch({
      frames: total,
      submitFrame: (g, slotBuffers) => {
        const direction = list[Math.floor(g / count)];
        const frame = frameIndex ?? g % frames;
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
        const direction = list[Math.floor(g / count)];
        const frame = frameIndex ?? g % frames;
        const tag = `d${pad(direction, 2)}_f${pad(frame, 3)}`;
        for (let k = 0; k < AOV_TARGETS.length; k++) {
          const png = encodeAov(planes[k], this.width, this.height, AOV_TARGETS[k].encode);
          await fs.writeFile(`${framesDir}/${tag}_${AOV_TARGETS[k].pass}.png`, png);
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
    const bufs: GPUBuffer[] = [];
    try {
      for (const bpr of unpadded) {
        bufs.push(device.createBuffer({
          size: bpr * this.height,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }));
      }
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
      }
      return planes;
    } finally {
      await settleGpuQueue(device);
      for (const buffer of bufs) {
        try {
          buffer.unmap();
        } catch { /* pending maps must not keep siblings alive */ }
        try {
          buffer.destroy();
        } catch { /* keep the original readback failure */ }
      }
    }
  }
}

/** Load + set up a renderer for a spec (shared by the seam and tests). */
export async function makeRenderer(
  gpu: GpuContext,
  spec: Pick<
    RenderJobSpec,
    | 'modelPath'
    | 'camera'
    | 'frames'
    | 'pose'
    | 'posesPath'
    | 'directionSubset'
    | 'lightFrame'
    | 'lighting'
  >,
  shaderSrc: string,
): Promise<Renderer> {
  assertRenderSize(gpu.device.limits, spec.camera.cellPx.w, spec.camera.cellPx.h);
  const pose = spec.pose ?? 'turntable';
  const asset = await loadSkinnedAsset(spec.modelPath);

  let clipPoses: ClipPoses | undefined;
  if (pose === 'clip') {
    if (!spec.posesPath) throw new Error("pose 'clip' requires posesPath");
    const { header, data } = await readPoses(spec.posesPath);
    if (header.frames !== spec.frames) {
      throw new Error(
        `poses file has ${header.frames} frames, spec asks for ${spec.frames} - ` +
          `they must match exactly (the sampling contract owns frame count)`,
      );
    }
    const map = mapPosesJoints(asset.jointNames, header);
    clipPoses = { data, map, jointsPerFrame: header.jointNames.length };
  }

  // frame the STABLE per-clip bounds (union over the posed frames), not the bind
  // pose — a rotating/moving silhouette sweeps outside the bind AABB (m6).
  const bounds = clipPoses
    ? posedBoundsFromPoses(
      asset,
      clipPoses.data,
      clipPoses.map,
      clipPoses.jointsPerFrame,
      spec.frames,
    )
    : posedBounds(asset, spec.frames, pose);
  const framing = solveFraming(spec.camera, bounds);
  return Renderer.create(
    gpu,
    asset,
    framing,
    shaderSrc,
    spec.camera.cellPx.w,
    spec.camera.cellPx.h,
    pose,
    clipPoses,
    validateSubset(spec.directionSubset, spec.camera.directions),
    spec.lightFrame ?? spec.lighting?.frame ?? DEFAULT_LIGHT_FRAME,
    spec.lighting,
  );
}

/**
 * A direction subset must name real directions, exactly once each. A silently
 * dropped or duplicated direction becomes a hole (or a doubled frame) in a
 * sprite sheet, which nobody notices until the character teleports mid-walk.
 */
function validateSubset(subset: number[] | undefined, directions: number): number[] | undefined {
  if (subset === undefined) return undefined;
  if (subset.length === 0) {
    throw new Error('directionSubset is empty - omit it to render every direction');
  }
  const seen = new Set<number>();
  for (const d of subset) {
    if (!Number.isInteger(d) || d < 0 || d >= directions) {
      throw new Error(
        `directionSubset contains ${d}, but this camera preset has ${directions} directions ` +
          `(valid: 0..${directions - 1})`,
      );
    }
    if (seen.has(d)) throw new Error(`directionSubset lists direction ${d} twice`);
    seen.add(d);
  }
  return [...subset];
}
