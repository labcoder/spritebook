import { settleGpuQueue } from './gpu.ts';
/**
 * Double-buffered pixel readback for the N-AOV pass (webgpu-headless-rendering
 * skill). Generalized from the P0-T2 spike: a pool of `poolSize` slots, each
 * holding one MAP_READ buffer per AOV. The batch loop never awaits mapAsync for
 * the frame it just submitted — it drains the oldest in-flight slot while later
 * frames encode, so CPU↔GPU stays pipelined.
 *
 * The 256-byte `bytesPerRow` padding + the post-map strip live here and nowhere
 * else — misaligned copies fail loudly, an un-stripped copy shears silently, so
 * this is the one place that logic is written and tested (the width-100 strip
 * test drives it).
 */

export interface BatchMetrics {
  frames: number;
  wallMs: number;
  fps: number;
  mapWaitMs: number;
  consumeMs: number;
  /** honest (unpadded) bytes read back per frame, summed over AOVs */
  bytesPerFrame: number;
  readbackMBps: number;
}

interface Slot {
  buffers: GPUBuffer[]; // one per AOV, size paddedBPR[k] * height
  frame: number;
  mappings: Promise<unknown>[];
  mapped: Promise<unknown> | null;
}

/** Encode the render pass + one copyTextureToBuffer per AOV into `slotBuffers`, then submit. */
export type SubmitFrame = (frame: number, slotBuffers: GPUBuffer[]) => void;
export type Consume = (frame: number, planes: Uint8Array[]) => void | Promise<void>;

export function align256(bytesPerRow: number): number {
  return Math.ceil(bytesPerRow / 256) * 256;
}

export class ReadbackPool {
  readonly width: number;
  readonly height: number;
  readonly unpaddedBPR: number[];
  readonly paddedBPR: number[];
  private device: GPUDevice;
  private aovCount: number;

  constructor(
    device: GPUDevice,
    width: number,
    height: number,
    bpp: number[],
    readonly poolSize = 3,
  ) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.aovCount = bpp.length;
    this.unpaddedBPR = bpp.map((b) => width * b);
    this.paddedBPR = this.unpaddedBPR.map(align256);
  }

  private makeSlot(allocated: GPUBuffer[]): Slot {
    const usage = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
    return {
      buffers: this.paddedBPR.map((bpr) => {
        const buffer = this.device.createBuffer({ size: bpr * this.height, usage });
        allocated.push(buffer);
        return buffer;
      }),
      frame: -1,
      mappings: [],
      mapped: null,
    };
  }

  /** Strip one mapped AOV buffer's row padding into `out` (length unpaddedBPR*height), then unmap. */
  private stripInto(buf: GPUBuffer, k: number, out: Uint8Array): void {
    const src = new Uint8Array(buf.getMappedRange());
    const padded = this.paddedBPR[k];
    const unpadded = this.unpaddedBPR[k];
    if (padded === unpadded) {
      out.set(src.subarray(0, out.length));
    } else {
      for (let y = 0; y < this.height; y++) {
        out.set(src.subarray(y * padded, y * padded + unpadded), y * unpadded);
      }
    }
    buf.unmap();
  }

  /**
   * Render `frames` frames through the pool. `submitFrame` does the encode +
   * copies + submit for one frame; the pool owns slot rotation, mapping, the
   * strip, `consume`, and the timing. `warmup` frames prime lazy pipeline
   * compilation and are excluded from the metrics.
   */
  async runBatch(opts: {
    frames: number;
    firstFrame?: number;
    warmup?: number;
    submitFrame: SubmitFrame;
    consume: Consume;
    onFrameDone?: (n: number) => void;
  }): Promise<BatchMetrics> {
    const { frames, firstFrame = 0, warmup = 3, submitFrame, consume, onFrameDone } = opts;
    const allocated: GPUBuffer[] = [];
    const slots: Slot[] = [];
    try {
      for (let i = 0; i < this.poolSize; i++) slots.push(this.makeSlot(allocated));
      const planes = this.unpaddedBPR.map((bpr) => new Uint8Array(bpr * this.height));

      let mapWaitMs = 0;
      let consumeMs = 0;
      let done = 0;

      const submit = (frame: number, slot: Slot) => {
        submitFrame(frame, slot.buffers);
        slot.frame = frame;
        slot.mappings = slot.buffers.map(async (b) => await b.mapAsync(GPUMapMode.READ));
        slot.mapped = Promise.all(slot.mappings);
        // Later slots may reject while an older frame's consumer is still writing its PNGs.
        void slot.mapped.catch(() => {});
      };

      const resolve = async (slot: Slot, timed: boolean) => {
        const t0 = performance.now();
        await slot.mapped;
        const t1 = performance.now();
        for (let k = 0; k < this.aovCount; k++) this.stripInto(slot.buffers[k], k, planes[k]);
        slot.mapped = null;
        slot.mappings = [];
        if (timed) await consume(slot.frame, planes);
        const t2 = performance.now();
        if (timed) {
          mapWaitMs += t1 - t0;
          consumeMs += t2 - t1;
          onFrameDone?.(done++);
        }
      };

      // untimed warmup, fully drained
      for (let w = 0; w < warmup; w++) {
        submit(firstFrame, slots[0]);
        await resolve(slots[0], false);
      }

      const free = [...slots];
      const inFlight: Slot[] = [];
      const tStart = performance.now();
      for (let f = 0; f < frames; f++) {
        let slot: Slot;
        if (free.length > 0) slot = free.pop()!;
        else {
          slot = inFlight.shift()!;
          await resolve(slot, true);
        }
        submit(firstFrame + f, slot);
        inFlight.push(slot);
      }
      while (inFlight.length > 0) await resolve(inFlight.shift()!, true);
      const wallMs = performance.now() - tStart;

      const bytesPerFrame = this.unpaddedBPR.reduce((n, bpr) => n + bpr * this.height, 0);
      return {
        frames,
        wallMs,
        fps: frames / (wallMs / 1000),
        mapWaitMs,
        consumeMs,
        bytesPerFrame,
        readbackMBps: (bytesPerFrame * frames) / (wallMs / 1000) / (1024 * 1024),
      };
    } finally {
      await settleGpuQueue(this.device);
      // Unmapping cancels pending maps too. Keep releasing siblings if a driver rejects cleanup.
      for (const buffer of allocated) {
        try {
          buffer.unmap();
        } catch { /* preserve the operation's original failure */ }
        try {
          buffer.destroy();
        } catch { /* release the remaining buffers */ }
      }
      await Promise.allSettled(slots.flatMap((slot) => slot.mappings));
    }
  }
}
