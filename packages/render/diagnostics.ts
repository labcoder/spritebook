/**
 * Render identity + health as PLAIN DATA (D-004: nothing GPU-shaped crosses the
 * seam — strings, numbers, and JSON-safe records only).
 *
 * renderSignature (D-023): `<RENDERER_VERSION>#<8-hex sha256 of adapterInfo>`.
 * The composed string is what cache keys carry as `rendererVersion`, so a GPU
 * or driver change flips every key — an honest full miss, because pixels are
 * only deterministic per (pipeline version, adapter, driver). It lands verbatim
 * in BakeManifest.inputs for provenance, and `spritebook doctor` prints it.
 *
 * renderDiagnostics: the doctor payload — versions, backend env, adapter info,
 * features, the limits we depend on, and an optional clear-pass probe that
 * exercises device init -> render pass -> readback and checksums the bytes
 * (a 16x16 transparent-black clear is byte-identical on every conforming
 * backend, so the checksum doubles as a tiny cross-machine sanity anchor).
 */
import { canonicalJson } from '@spritebook/schema';
import { sha256Hex } from '@spritebook/core';
import { getGpu, tryGetGpu } from './gpu.ts';
import { createAovPassDescriptor, createAovTargets } from './aov.ts';
import { RENDERER_VERSION } from './contracts.ts';

/** The cache-key renderer identity. Throws (actionably) when no adapter exists. */
export async function renderSignature(): Promise<string> {
  const gpu = await getGpu();
  const hash = await sha256Hex(canonicalJson(gpu.adapterInfo));
  return `${RENDERER_VERSION}#${hash.slice(0, 8)}`;
}

export interface RenderDiagnostics {
  version: string;
  backendEnv: string;
  available: boolean;
  signature?: string;
  adapter?: Record<string, unknown>;
  features?: string[];
  limits?: Record<string, number>;
  probe?: { ok: boolean; checksum?: string; error?: string };
  hints?: string[];
}

const NO_ADAPTER_HINTS = [
  'Check that your GPU drivers are installed and current.',
  'Force a backend with DENO_WEBGPU_BACKEND=vulkan (Windows/Linux), dx12 (Windows), or metal (macOS).',
  'Headless Linux / CI: install Mesa lavapipe (mesa-vulkan-drivers) for a software adapter.',
];

/** Clear-only render probe: device -> AOV targets -> pass -> readback -> sha256. */
async function clearProbe(
  device: GPUDevice,
): Promise<{ ok: boolean; checksum?: string; error?: string }> {
  try {
    const size = 16;
    const targets = createAovTargets(device, size, size);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass(createAovPassDescriptor(targets));
    pass.end(); // clear only — no geometry; deterministic bytes by spec
    const bytesPerRow = 256; // 16 px * 4 B = 64, padded to the 256 floor
    const buf = device.createBuffer({
      size: bytesPerRow * size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    encoder.copyTextureToBuffer(
      { texture: targets.lit },
      { buffer: buf, bytesPerRow },
      { width: size, height: size },
    );
    device.queue.submit([encoder.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const pixels = new Uint8Array(size * 4 * size);
    for (let y = 0; y < size; y++) {
      pixels.set(src.subarray(y * bytesPerRow, y * bytesPerRow + size * 4), y * size * 4);
    }
    buf.unmap();
    buf.destroy();
    for (const t of targets.color) t.destroy();
    targets.depthStencil.destroy();
    let bin = '';
    for (const b of pixels) bin += String.fromCharCode(b);
    return { ok: true, checksum: (await sha256Hex(bin)).slice(0, 16) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function renderDiagnostics(
  opts: { probe?: boolean } = {},
): Promise<RenderDiagnostics> {
  const version = RENDERER_VERSION;
  const backendEnv = Deno.env.get('DENO_WEBGPU_BACKEND') ?? '(unset - wgpu default)';
  const gpu = await tryGetGpu(); // SPRITEBOOK_REQUIRE_GPU turns a missing adapter into a throw
  if (!gpu) {
    return { version, backendEnv, available: false, hints: NO_ADAPTER_HINTS };
  }
  const l = gpu.device.limits;
  const out: RenderDiagnostics = {
    version,
    backendEnv,
    available: true,
    signature: `${version}#${(await sha256Hex(canonicalJson(gpu.adapterInfo))).slice(0, 8)}`,
    adapter: gpu.adapterInfo,
    features: gpu.features,
    limits: {
      maxColorAttachments: l.maxColorAttachments,
      maxColorAttachmentBytesPerSample: l.maxColorAttachmentBytesPerSample,
      maxTextureDimension2D: l.maxTextureDimension2D,
      maxBufferSize: l.maxBufferSize,
    },
  };
  if (opts.probe) out.probe = await clearProbe(gpu.device);
  return out;
}
