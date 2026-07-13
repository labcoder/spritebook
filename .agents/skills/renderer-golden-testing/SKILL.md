---
name: renderer-golden-testing
description: Visual regression and structural testing for GPU-rendered output. Use this skill whenever writing or modifying tests for the render module, NPR style stack, packer image output, or exporters — and whenever an image test passes on one machine and fails on another, a golden needs updating, or CI needs to run renderer tests without a GPU. Covers golden storage and update workflow, tolerance calibration, exact structural assertions, cross-machine GPU variance, and the flakiness protocol.
---

# Golden-image and structural testing for the renderer

GPU output is deterministic per machine and _not_ deterministic across machines. Every rule here
follows from that fact.

## Two assertion classes — always reach for the first one first

**1. Exact structural invariants** (no tolerance, no goldens, cheap, unambiguous):

- Output dimensions equal `cellSize`; alpha-occupied bounding box stays inside `paddingPx`.
- Pivot lands on the expected pixel; two characters under one CameraPreset share scale (world-locked
  framing).
- **Palette membership:** for quantized styles, every non-transparent pixel's color ∈ the preset
  palette. This single assertion catches most quantizer regressions exactly, with zero tolerance
  debate.
- Frame counts match ClipBinding sampling; parallel AOV atlas pages are rect-identical to the lit
  page; mirrored frames appear only when the manifest flags them.

Prefer adding a structural assertion over a new golden whenever the property can be stated exactly —
structural tests never rot and never argue about thresholds.

**2. Tolerant golden comparison** for everything perceptual (shading, outlines, dithers): compare
per-pixel with a per-channel tolerance plus a max-differing-fraction, e.g. _pass if ≤0.5% of pixels
differ by >2/255 per channel_. `npm:pixelmatch` works in Deno on raw RGBA buffers and produces a
diff image.

## Failure output is not optional

On any golden failure, always write three PNGs to the failures directory (uploaded as CI artifacts):
actual, expected, and a diff heatmap. A red-splat image localizes a regression in seconds; a "0.7% >
0.5%" log line localizes nothing.

## Cross-machine reality

- Never assert byte-equality across machines or drivers.
- **Do** assert byte-equality for a same-process double render of the same inputs — this is the
  nondeterminism canary, and it catches accidental entropy (map iteration order, time-seeded
  anything, uninitialized buffers) the moment it's introduced.
- Pin `DENO_WEBGPU_BACKEND` in CI so comparisons are like-for-like.

## Golden lifecycle

- Goldens are keyed `{test}-{stylePreset}-{pass}.png`, kept small (64–128 px cells keep the whole
  set a few MB — fine in-repo; move to LFS only if it grows).
- Update only via the dedicated task (`deno task goldens:update -- <filter>`), never by loosening an
  assertion to make red go green.
- Golden changes are reviewed **as images** in the PR (GitHub renders them side by side). A
  `rendererVersion` bump is expected to arrive with a golden-refresh commit whose message says _why_
  pixels changed; a golden change without a renderer change is a bug report.
- Tolerances start strict (2/255, 0.1–0.5%) and widen only per-test with a recorded reason. A global
  tolerance increase is forbidden — it's how golden suites quietly die.

## CI without GPUs

Hosted CI runners have no GPU. The working strategy, in order of preference:

1. **Structural assertions run everywhere** — they don't need real rasterization quality, just a
   functioning adapter.
2. On Linux CI, Mesa **lavapipe** (software Vulkan) provides a real-if-slow WebGPU adapter: good
   enough for structural tests and smoke renders. Treat lavapipe pixels as a **separate golden set**
   if you compare them at all — software rasterization does not match hardware output, and mixing
   the sets poisons both.
3. The full hardware golden suite runs on the dev GPU pre-merge and on a self-hosted/nightly GPU
   runner. Reference-parity checks against the p0 look-dev imagery live in a pre-release suite, not
   per-commit.

## Test fixtures

Golden tests render a tiny rigged fixture (low-poly capsule-person, one idle clip) that draws in
milliseconds — never a production character. Keep one deliberately asymmetric fixture (single-arm
marking) so mirroring regressions are visually unmissable.

## Flakiness protocol

An image test that flakes is reporting nondeterminism — a bug, not noise. Auto-retry is forbidden on
image suites; a flake gets investigated via the double-render canary, not silenced. The day retries
go in is the day the suite stops meaning anything.
