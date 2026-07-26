/**
 * Device/adapter management + diagnostics (webgpu-headless-rendering skill).
 * `initGPU` returns either a usable device or throws an actionable error naming
 * DENO_WEBGPU_BACKEND. `device.lost` is captured on the context so a bake job
 * can convert it into a RETRYABLE error rather than a mystery abort.
 */
import { type GpuContext, REQUIRED_LIMITS } from './contracts.ts';

export async function initGPU(): Promise<GpuContext> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    const backend = Deno.env.get('DENO_WEBGPU_BACKEND') ?? '(unset)';
    throw new Error(
      `No WebGPU adapter (DENO_WEBGPU_BACKEND=${backend}). ` +
        `Check GPU drivers; try DENO_WEBGPU_BACKEND=vulkan, metal, or dx12.`,
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
    console.error(`device lost (retryable): ${info.reason} - ${info.message}`);
  });
  return ctx;
}

/**
 * Process-wide device singleton. Deno's wgpu is unhappy with several GPUDevices
 * live in one process, and one device per CLI process is the right production
 * model anyway (device creation is expensive) — so every render job and every
 * test shares this one context.
 */
let shared: Promise<GpuContext> | undefined;
export function getGpu(): Promise<GpuContext> {
  if (!shared) shared = initGPU();
  return shared;
}

/**
 * getGpu, but return null instead of throwing when no adapter exists — hosted CI
 * runners have no GPU, so render suites skip there. Set SPRITEBOOK_REQUIRE_GPU
 * (the lavapipe lane does) to turn a missing adapter back into a hard failure, so
 * a broken software-Vulkan lane can't masquerade as "all tests skipped, green".
 *
 * The skip SAYS SO, once per caller. `if (!(await tryGetGpu())) return;` is how
 * roughly sixteen tests across eight files begin, and a bare `return` makes Deno
 * print `ok` — so on a machine with no adapter the entire acceptance suite
 * reported success while asserting nothing, which is the exact shape of failure
 * this project keeps finding. Deno prints the test's name immediately above its
 * output, so one line here reads as that test declining to run.
 */
export async function tryGetGpu(): Promise<GpuContext | null> {
  try {
    return await getGpu();
  } catch (err) {
    if (Deno.env.get('SPRITEBOOK_REQUIRE_GPU')) throw err;
    console.log(
      'skip: no GPU adapter — this test asserted NOTHING. ' +
        'Set SPRITEBOOK_REQUIRE_GPU=1 to make a missing adapter a failure instead.',
    );
    return null;
  }
}

/** adapter.info fields are prototype getters — JSON.stringify shows {}; walk the chain. */
function walkInfo(info: GPUAdapterInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (
    let p = Object.getPrototypeOf(info);
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
