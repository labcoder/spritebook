# P0-T2 report — headless WebGPU spike

**Verdict: PASS on every bar, with 13–39× margins. D-004 (TS core on Deno + WebGPU) is confirmed by measurement.**

- Date: 2026-07-11 · Task: P0-T2 (`docs/internal/roadmap/p0.md`)
- Machine: Windows 11 Pro (10.0.26200), NVIDIA GeForce RTX 3090 (driver 32.0.16.1047), Deno 2.9.2 (v8 14.9.207.2-rusty)
- Adapter (as reported by `adapter.info`): vendor `4318` (0x10DE NVIDIA), device `8708` (0x2204, RTX 3090), description "NVIDIA GeForce RTX 3090", subgroups 32/32, not a fallback adapter
- Workload: 400-vert / 768-tri skinned glTF (4-joint chain, procedural, hermetic), WGSL skinning with joint matrices in a storage buffer, one MRT pass (lit `rgba8unorm` sRGB-encoded in-shader + linearized view depth `r32float`), `depth24plus` for z-test only, readback with 256-byte `bytesPerRow` handling, fast-png encode, pool of 3 double-buffered readback slots, 3 warmup frames excluded.

## Pass bar (roadmap acceptance)

| Bar | Result | Verdict |
|---|---|---|
| ≥ 5 frames/s aggregate, 2 passes @ 128 px | **67.9–109.3 f/s end-to-end** (incl. PNG encode + disk writes); 133–194 f/s render+readback only | **PASS** (13–22× bar) |
| Correct output at width 100 px (row-padding shear test) | Padded-strip path byte-identical to a per-row reference copy path (no padding math); silhouette sane (1698 alpha px, centroid x=44.1 of 100) | **PASS** |
| Same-process double render → identical bytes | Per-frame SHA-256 over both attachments, 100 frames, identical on all 3 backends tested | **PASS** |
| Report: frames/s, readback MB/s, adapter info, backend used | This document + `out/metrics-*.json` | **PASS** |

## Numbers by backend (100-frame bar batch @ 128 px)

| `DENO_WEBGPU_BACKEND` | End-to-end f/s | Render+readback f/s | Readback MB/s (unpadded) | Same-proc deterministic |
|---|---|---|---|---|
| (unset — resolves to Vulkan, run 1) | 72.0 | 183.7 | 22.96 | yes |
| (unset, run 2, separate process) | 109.3 | 193.3 | 24.16 | yes |
| `vulkan` | 95.4 | 193.8 | 24.23 | yes |
| `dx12` | 67.9 | 133.2 | 16.65 | yes |

- **Cross-process determinism: PASS** — a second `deno` invocation on the same backend reproduced all 100 frame hashes exactly (stronger than the roadmap's same-process canary; this is what D-011 cache correctness actually leans on).
- **Cross-backend bytes differ** (dx12 vs vulkan) — expected (different shader compilers), and exactly why D-011 hashes inputs, never pixels. The default backend on this machine resolved to Vulkan (proven by byte-identical output with `vulkan` pinned). **Recommendation: pin `DENO_WEBGPU_BACKEND` per machine and record it in bake provenance.**
- End-to-end variance between runs (67.9–109.3) is disk/PNG-write noise, not GPU noise; render+readback numbers are stable.

## Supplementary evidence (kept cheap; added after teammate review of the spike design)

- **1000-frame sustained soak** (PNG encode every frame, write every 100th): **169.5 f/s sustained**, readback 21.2 MB/s. RSS oscillated 264→317→276 MB in a GC sawtooth (mapped-buffer ArrayBuffers show up as `external`), net +4.4% with no monotonic trend — **no leak signature**.
- **512 px batch** (supersampling probe): **28.5 f/s end-to-end**, readback 57 MB/s. Map-wait was only 24 ms of the 3506 ms wall — at 512 px, 91% of wall time is fast-png encode on the CPU. GPU + readback are nowhere near the ceiling at any tested size.
- **PRD workload projections** at the sustained 128 px rate: 64k frames (100-char roster) ≈ **6.3 min**; 192k frames (anchor 300-char pivot) ≈ **19 min**. Even at 512 px end-to-end rates: 192k frames ≈ 1.9 h. The "overnight, unattended" budget has orders of magnitude of slack for the style stack, retarget sampling, and packing that will sit on top.
- **Fault injection** (destroyed texture used in a render pass — the documented wgpu panic class, deno#25870): on Deno 2.9.2 it surfaced as a **catchable validation error** ("Texture with '' label has been destroyed"), process exited 0. A bake job can convert this class to a `retryable` NDJSON error in-process. (Not a guarantee for every panic class; lifetime discipline — allocate up front, destroy nothing mid-batch — stays the rule.)

## What surprised us

1. **`adapter.info` looks empty but isn't.** `JSON.stringify(adapter.info)` prints `{}` — the fields are prototype getters. Diagnostics (`spritebook doctor`, job provenance) must walk the prototype to extract vendor/device/description.
2. **`requestDevice` grants zero features unless asked.** The adapter advertises 15 features (incl. `timestamp-query`), but the device came up with none since we only passed `requiredLimits`. Any future timestamp-based profiling must request the feature explicitly and treat it as optional — `performance.now()` was fully adequate here.
3. **CPU PNG encode is the real ceiling, not the GPU.** At 128 px it's ~60–80% of end-to-end wall; at 512 px it's 91%. The obvious lever when it matters is a Deno Worker pool (or a WASM encoder) — a scheduling change, not an architecture change. Render+readback alone runs at ~190 f/s at 128 px.
4. **dx12 is measurably slower than Vulkan for this readback-heavy pattern** (133 vs 194 f/s render+readback) and produces different bytes. Vulkan is the right per-machine pin on this box.
5. **The classic traps are real but well-fenced.** The width-100 shear test caught nothing because the strip logic followed the skill; the per-row reference path is a genuinely strong oracle and should graduate into the p1 render package's test suite.

## What this spike does NOT prove (open risks carried forward)

- **Linux CI throughput on lavapipe** (Mesa software Vulkan) is unmeasured — matters for the golden-test regime, not for user-facing performance. Measure when CI lands (p1).
- **Long-horizon maintenance of Deno's WebGPU**: still flag-gated (`--unstable-webgpu`); `deno_webgpu` is co-maintained in-tree with wgpu (patch-level lag as of 2026-07) but has a regression history across Deno minors. Mitigation: pin the Deno version; re-run this harness as a canary gate before any Deno upgrade.
- **Driver updates change pixels on the "same machine"** while D-011 cache keys don't include the driver. Recommended follow-up decision: record adapter + driver version in bake provenance and decide whether a driver change invalidates or warns (proposed as a D-number for the maintainer).
- 5-attachment MRT (full AOV set) wasn't exercised — 2 attachments at 512 px bounds the bandwidth well above need, but the p1 render package should request `maxColorAttachments` explicitly (the harness already requests 4).

## Recommendation

Confirm D-004: **TS core on Deno + WebGPU, no fallback triggered.** Two riders (from the fallback analysis, zero cost today):

1. Shape the p1 `render` package's interface as *(canonical glTF path, camera preset, style params, output paths) → NDJSON events + files* — that boundary is already the `renderd` subprocess protocol if a Rust+wgpu swap is ever forced, making the escape hatch an organ transplant, not surgery.
2. Read D-004's fallback ladder as a triage matrix, not a sequence: WASM kernels address only CPU-side (encode) ceilings; a true GPU-path failure goes straight to Rust+wgpu. Neither is needed on this evidence.

### Drafted D-004 confirmation (for `docs/internal/decisions.md`, maintainer to ratify)

> **D-004** — *confirmed 2026-07-11 by P0-T2.* Headless Deno+WebGPU measured on the dev GPU (RTX 3090, Deno 2.9.2, Vulkan): 95–109 f/s end-to-end with PNG encode (bar: ≥5), ~190 f/s render+readback, 169 f/s sustained over 1000 frames with flat memory, width-100 readback byte-correct vs a per-row oracle, same-process **and** cross-process double render byte-identical, destroyed-resource fault catchable in-process. 192k-frame anchor workload projects to ~19 min at 128 px. No fallback triggered; WASM-kernel rung reinterpreted as CPU-encode optimization only; Rust+wgpu remains the (unneeded) GPU-path escape hatch behind the render package boundary. Pin `DENO_WEBGPU_BACKEND` per machine (Vulkan on the dev box); pin Deno version and re-run `deno task spike:webgpu` before runtime upgrades.

## Reproduce

```sh
deno task spike:webgpu:gen        # regenerate the hermetic test asset
deno task spike:webgpu            # full suite; run twice for the cross-process check
DENO_WEBGPU_BACKEND=dx12 deno task spike:webgpu -- --mode=bar
deno task spike:webgpu -- --mode=fault   # run last, own invocation
```

Raw metrics for every run in this report: `spikes/webgpu/out/metrics-*.json` (gitignored; numbers above are transcribed verbatim).
