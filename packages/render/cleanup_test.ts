import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { ReadbackPool } from './dist/readback.js';
import { createAovPipeline, createAovTargets } from './dist/aov.js';
import { Renderer } from './dist/renderer.js';
import { loadSkinnedAsset, posedBounds } from './dist/skinning.js';
import { solveFraming } from './dist/camera.js';
import { tryGetGpu } from './dist/gpu.js';
import { runRenderJob } from './dist/mod.js';
import type { GpuContext } from './dist/contracts.js';

const CAMERA = {
  id: 'cleanup',
  elevationDeg: 30,
  directions: 2 as const,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32,
  cellPx: { w: 64, h: 64 },
  paddingPx: 6,
  pivot: 'center' as const,
  orthographic: true,
};
const MODEL = fileURLToPath(new URL('./fixtures/skinned-column.glb', import.meta.url));

function fakeConstants(t: TestContext) {
  const values = {
    GPUBufferUsage: { MAP_READ: 1, COPY_DST: 8, VERTEX: 32, INDEX: 16, STORAGE: 128, UNIFORM: 64 },
    GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 },
    GPUMapMode: { READ: 1 },
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
}

/** A finite device model: its live resources represent allocations, not private call order. */
function deviceFixture(mode = '') {
  const live = new Set<{ destroy(): void }>();
  const buffers: { mapped: boolean }[] = [];
  let count = 0, scopes = 0;
  let finish!: () => void;
  let lose!: (info: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => lose = resolve);
  const work = mode === 'upload' || mode === 'validation'
    ? new Promise<void>((resolve) => finish = resolve)
    : Promise.resolve();
  let finishLostWork!: () => void;
  const lostWork = new Promise<void>((resolve) => finishLostWork = resolve);
  const failure = new Error(`injected ${mode} failure`);
  const device = {
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 2 ** 30 },
    lost,
    queue: {
      onSubmittedWorkDone: () => {
        if (mode === 'queue-rejection') return Promise.reject(failure);
        return mode.startsWith('lost') ? lostWork : work;
      },
      writeBuffer() {},
      writeTexture() {
        if (mode === 'upload') throw failure;
      },
    },
    pushErrorScope() {
      scopes++;
    },
    async popErrorScope() {
      const outer = scopes === 1;
      scopes--;
      return mode === 'validation' && outer ? { message: failure.message } : null;
    },
    createShaderModule() {
      if (mode === 'shader') throw failure;
      return {};
    },
    createRenderPipeline() {
      return { getBindGroupLayout: () => ({}) };
    },
    createSampler() {
      return {};
    },
    createBindGroup() {
      return {};
    },
    createTexture() {
      if (mode === 'texture-allocation' && ++count === 4) throw failure;
      const texture = { createView: () => ({}), destroy: () => live.delete(texture) };
      live.add(texture);
      return texture;
    },
    createBuffer({ size }: { size: number }) {
      const index = count++;
      if (mode === 'buffer-allocation' && index === 5) throw failure;
      const data = new ArrayBuffer(size);
      let cancelMapping: ((error: Error) => void) | undefined;
      const buffer = {
        mapped: false,
        async mapAsync() {
          if (mode === 'lost-mapping') {
            if (index === 5) throw failure;
            await new Promise<void>((_, reject) => cancelMapping = reject);
          }
          if (mode === 'mapping' && index === 5) throw failure;
          if (mode === 'mapping' && index === 2) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            throw new Error('later mapping also failed');
          }
          buffer.mapped = true;
        },
        getMappedRange: () => {
          if (mode === 'range' && index === 5) throw failure;
          return data;
        },
        unmap() {
          cancelMapping?.(new Error('mapping cancelled'));
          cancelMapping = undefined;
          buffer.mapped = false;
        },
        destroy() {
          live.delete(buffer);
        },
      };
      buffers.push(buffer);
      live.add(buffer);
      return buffer;
    },
  } as unknown as GPUDevice;
  return {
    device,
    live,
    buffers,
    failure,
    finish: () => finish(),
    scopes: () => scopes,
    lose: () => {
      finishLostWork();
      lose({ reason: 'unknown', message: failure.message } as GPUDeviceLostInfo);
    },
  };
}

test('readback failures release partial allocations and in-flight mappings without replacing the first error', async (t) => {
  fakeConstants(t);
  for (
    const mode of [
      'buffer-allocation',
      'submit',
      'mapping',
      'range',
      'consumer',
      'lost',
      'lost-mapping',
      'queue-rejection',
    ]
  ) {
    const fixture = deviceFixture(mode);
    if (mode.startsWith('lost')) fixture.lose();
    const pool = new ReadbackPool(fixture.device, 100, 2, [4, 4]);
    const batch = pool.runBatch({
      frames: 4,
      warmup: 0,
      submitFrame: () => {
        if (mode === 'submit' || mode === 'lost' || mode === 'queue-rejection') {
          throw fixture.failure;
        }
      },
      consume: () => {
        if (mode === 'consumer') throw fixture.failure;
      },
    });
    await assert.rejects(batch, (error) => error === fixture.failure);
    assert.equal(fixture.live.size, 0, `${mode}: all allocations reclaimed`);
    assert(fixture.buffers.every((buffer) => !buffer.mapped), `${mode}: no mapped buffers survive`);
  }
});

test('failed renderer setup closes error scopes and releases targets and upload buffers after queue drain', async (t) => {
  fakeConstants(t);
  const asset = await loadSkinnedAsset(MODEL);
  const framing = solveFraming(CAMERA, posedBounds(asset, 1));
  for (const mode of ['shader', 'texture-allocation', 'upload', 'validation']) {
    const fixture = deviceFixture(mode);
    if (mode === 'shader') {
      await assert.rejects(
        createAovPipeline(fixture.device, ''),
        (error) => error === fixture.failure,
      );
    } else if (mode === 'texture-allocation') {
      assert.throws(
        () => createAovTargets(fixture.device, 64, 64),
        (error) => error === fixture.failure,
      );
    } else {
      const pending = Renderer.create(
        { device: fixture.device } as GpuContext,
        asset,
        framing,
        '',
        64,
        64,
      );
      const rejected = assert.rejects(pending, new RegExp(fixture.failure.message));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert(fixture.live.size > 0, 'queued uploads must keep their allocations alive');
      fixture.finish();
      await rejected;
    }
    assert.equal(fixture.live.size, 0, `${mode}: no partial setup allocations survive`);
    assert.equal(fixture.scopes(), 0, `${mode}: error scope stack is balanced`);
  }
});

test('real render failure and event-consumer return release the renderer without poisoning the shared device', async (t) => {
  const gpu = await tryGetGpu();
  if (!gpu) {
    t.skip('No WebGPU adapter');
    return;
  }
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-render-cleanup-'));
  const live = new Set<GPUTexture | GPUBuffer>();
  for (const method of ['createTexture', 'createBuffer'] as const) {
    const original = gpu.device[method].bind(gpu.device) as (
      descriptor: never,
    ) => GPUTexture | GPUBuffer;
    t.mock.method(gpu.device, method, (descriptor: never) => {
      const resource = original(descriptor);
      live.add(resource);
      const destroy = resource.destroy.bind(resource);
      t.mock.method(resource, 'destroy', () => {
        live.delete(resource);
        destroy();
      });
      return resource;
    });
  }
  const spec = {
    jobId: 'cleanup',
    modelPath: MODEL,
    camera: CAMERA,
    frames: 1,
    stylePreset: 'clean',
    outDir: root,
  };
  try {
    const iterator = runRenderJob(spec)[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done) assert.fail('setup must finish before the consumer closes');
      if (next.value.t === 'progress' && next.value.step === 'setup') break;
    }
    assert(live.size > 0);
    await iterator.return?.();
    assert.equal(live.size, 0, 'closing the event consumer releases renderer setup');
    const write = fs.writeFile;
    const failure = new Error('disk is full');
    const mock = t.mock.method(
      fs,
      'writeFile',
      async (...args: Parameters<typeof fs.writeFile>) => {
        if (String(args[0]).endsWith('_lit.png')) throw failure;
        return write(...args);
      },
    );
    const events = [];
    for await (const event of runRenderJob(spec)) events.push(event);
    mock.mock.restore();
    const error = events.find((event) => event.t === 'error');
    assert(error?.t === 'error' && error.message === failure.message);
    assert.equal(live.size, 0, 'failed PNG output releases readback and render allocations');
    const complete = [];
    for await (const event of runRenderJob(spec)) complete.push(event);
    assert.equal(complete.at(-1)?.t, 'done', 'shared device still renders after the write failure');
    assert.equal(live.size, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
