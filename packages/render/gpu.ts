
/**
 * Device/adapter management + diagnostics (webgpu-headless-rendering skill).
 * `initGPU` returns either a usable device or throws an actionable error naming
 * SPRITEBOOK_GPU_BACKEND. `device.lost` is captured on the context so a bake job
 * can convert it into a RETRYABLE error rather than a mystery abort.
 */
import { type GpuContext, REQUIRED_LIMITS } from './contracts.ts';

export function gpuBackend(): string {
  const selected = process.env.SPRITEBOOK_GPU_BACKEND ?? process.env.DENO_WEBGPU_BACKEND;
  return selected === 'dx12' ? 'd3d12' : selected ?? (process.platform === 'darwin' ? 'metal' : 'vulkan');
}

export async function initGPU(): Promise<GpuContext> {
  const { create, globals } = await import('webgpu').catch((cause) => {
    throw Object.assign(new Error(`Cannot load the Dawn native addon: ${cause.message}`, { cause }), {
      code: 'native-addon-load',
    });
  });
  Object.assign(globalThis, globals);
  Object.defineProperty(navigator, 'gpu', { value: create([`backend=${gpuBackend()}`]), configurable: true });
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    delete (navigator as { gpu?: GPU }).gpu;
    const backend = gpuBackend();
    throw new Error(
      `No WebGPU adapter (SPRITEBOOK_GPU_BACKEND=${backend}). ` +
        `Check GPU drivers; try SPRITEBOOK_GPU_BACKEND=vulkan or metal.`,
    );
  }
  const adapterInfo = walkInfo(adapter.info);
  const device = await adapter.requestDevice({ requiredLimits: REQUIRED_LIMITS });
  const ctx: GpuContext = {
    adapter,
    device,
    adapterInfo,
    features: [...device.features].sort(),
    lost: null,
  };
  device.lost.then((info) => {
    ctx.lost = { reason: String(info.reason), message: info.message };
    if (info.reason !== 'destroyed') console.error(`device lost (retryable): ${info.reason} - ${info.message}`);
  });
  return ctx;
}

/**
 * One device per CLI process; initialization stays lazy for non-rendering commands.
 */
let shared: Promise<GpuContext> | undefined;
export function getGpu(): Promise<GpuContext> {
  if (!shared) shared = initGPU();
  return shared;
}

/** Release Dawn's root as well as the device, so Node can exit without force-exit. */
export async function disposeGpu(): Promise<void> {
  const pending = shared;
  shared = undefined;
  const gpu = await pending?.catch(() => undefined);
  gpu?.device.destroy();
  delete (navigator as { gpu?: GPU }).gpu;
}

/**
 * getGpu, but return null instead of throwing when no adapter exists — hosted CI
 * runners have no GPU, so render suites skip there. Set SPRITEBOOK_REQUIRE_GPU
 * (the lavapipe lane does) to turn a missing adapter back into a hard failure, so
 * a broken software-Vulkan lane can't masquerade as "all tests skipped, green".
 *
 * Test callers must also mark their TestContext skipped when this returns null.
 */
export async function tryGetGpu(): Promise<GpuContext | null> {
  try {
    return await getGpu();
  } catch (err) {
    if (process.env['SPRITEBOOK_REQUIRE_GPU']) throw err;
    return null;
  }
}

/** adapter.info fields are prototype getters — JSON.stringify shows {}; walk the chain. */
function walkInfo(info: GPUAdapterInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (
    let p = info;
    p && p !== Object.prototype;
    p = Object.getPrototypeOf(p)
  ) {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (k === 'constructor') continue;
      try {
        const v = (info as unknown as Record<string, unknown>)[k];
        if (typeof v !== 'function' && v !== undefined && v !== '') out[k] = v;
      } catch { /* getter threw — skip */ }
    }
  }
  return out;
}
