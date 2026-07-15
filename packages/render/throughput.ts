/**
 * The throughput report artifact — written on every render and uploaded from CI
 * so frames/sec and readback MB/s regressions are visible in the trend (P2-T1
 * acceptance). These numbers are machine-dependent (software Vulkan in CI is
 * slow by design), so this is a TREND signal, never a pass/fail gate and never
 * hashed for caching — the repo invariant is hash inputs, not rendered output.
 */
import type { BatchMetrics } from './readback.ts';

export interface ThroughputReport {
  frames: number;
  wallTimeS: number;
  fps: number;
  readbackMBps: number;
  bytesPerFrame: number;
  width: number;
  height: number;
  aovCount: number;
  backend: string;
  adapter: Record<string, unknown>;
}

export function buildThroughput(
  m: BatchMetrics,
  ctx: { width: number; height: number; aovCount: number; adapter: Record<string, unknown> },
): ThroughputReport {
  return {
    frames: m.frames,
    wallTimeS: m.wallMs / 1000,
    fps: m.fps,
    readbackMBps: m.readbackMBps,
    bytesPerFrame: m.bytesPerFrame,
    width: ctx.width,
    height: ctx.height,
    aovCount: ctx.aovCount,
    backend: Deno.env.get('DENO_WEBGPU_BACKEND') ?? '(unset)',
    adapter: ctx.adapter,
  };
}

export async function writeThroughput(path: string, report: ThroughputReport): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2) + '\n');
}
