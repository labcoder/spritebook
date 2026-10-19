# Node renderer qualification

Evidence date: **2026-10-19**. This is the bounded **F2** experiment, using the preserved
[F0 control](baseline.md) and the existing renderer, animation, style and pack modules. Production
Studio and the CLI still use Deno. The Tauri renderer-proof build is an isolated launcher, not a
migrated editor or a replacement application.

**Recommendation: retain Node/Dawn and qualify the Node PNG writer for promotion in F4.** Windows
x64 Vulkan passes the measured image and performance gates. The evidence does not justify a Rust
render worker. Other hardware, clean-machine delivery and complete redistribution clearance remain
gates; this report does not grant a support claim or a license-policy exception.

## Candidate and control

The candidate pins **Node 24.22.0**, **`webgpu` 0.6.2** and the **LunarG Vulkan Runtime 1.4.341.0**
x64 loader. Official runtime archives are SHA-256 pinned. Shader, native addon, JavaScript, fixture
and notice hashes are sealed in the build receipt. The control uses **Deno 2.9.2**, the same
production modules and the original PNG encoder. Neither path serves an old frame cache as fresh
rendering evidence.

The small [qualification harness](../tools/qualification/build.mjs) bundles existing TypeScript. Its
temporary [Node environment adapter](../tools/qualification/node-environment.mjs) implements only
the filesystem operations that this experiment executes; unsupported APIs fail explicitly. It is not
a Node port of transactions, model installation, subprocess policy or the CLI. Delete the adapter
during F4 rather than adopting a permanent global Deno shim.

The first unchanged-code Node trial produced matching images but missed the 10% regression budget:
the 4x median was **13.004 s versus 11.278 s**, **15.3% slower**. Its CPU profile concentrated time
in PNG byte serialization, compression and decoding. The candidate now substitutes a
[small Node PNG encoder](../tools/qualification/png.ts) at build time: bulk scanline copies, native
zlib at the original compression level, native CRC32, and 8/16-bit grayscale/RGB(A). `fast-png`
remains the independent decoder. Production encoding and WGSL remain unchanged.

The native encoder changes compressed PNG bytes. Image equality below concerns decoded channels;
new-runtime byte determinism is checked separately. No committed golden was refreshed or tolerance
widened. F4 must assign a new renderer/cache namespace covering this codec, build, backend, adapter
and available driver identity before promoting the candidate.

## Windows Vulkan measurements

Native Windows x64, RTX 3090, NVIDIA **610.88**, i9-10900K, approximately 64 GiB system RAM. Three
paired trials alternate runtime order. Each cold run has an empty application frame cache; each warm
run starts another process and must serve **100%** unchanged frames. OS and driver caches are not
cleared. Process times include startup, the bake and the same artifact assertions. These
measurements do not replace F0's separately measured full CLI journey.

| Supersampling | Deno cold | Node cold | Node change | Deno warm | Node warm |
| ------------- | --------: | --------: | ----------: | --------: | --------: |
| 1x            |   4.477 s |   3.732 s |      -16.6% |   2.468 s |   2.009 s |
| 2x            |   6.288 s |   5.284 s |      -16.0% |   2.552 s |   2.104 s |
| 4x            |  11.390 s |  10.030 s |      -11.9% |   2.526 s |   2.022 s |

**Result: pass without a performance exception.** There are 46 process runs: cold/warm repetitions
for the three-clip workload, all four styles on the asymmetric fixture, and explicit mirroring. The
representative workload is **96 frames**: idle/walk/action, four samples, eight directions, 100x128
cells, 32 px/m and padding 16. The accepted textured canonical mesh is copied from F0; it is a
mechanical fixture, not evidence of new model quality or likeness.

Reports retain per-clip render/readback/PNG throughput, sampled process RSS and whole-GPU memory.
RSS samples are taken every 20 ms; GPU memory every 100 ms includes the desktop and other GPU users.
They are observed peaks, not exact process VRAM allocations or admission floors.

## Image and structural gates

**110 original assertions run on Node**, including exact framing/scale/pivots, alpha and material
behavior, attachment placement and motion, retarget numerics, width-100 padded versus row-by-row
readback, palette membership, AOV encoding/layout, mirror normal handling and style goldens. The
runner preserves their expectations; it does not reproduce their implementation. It lacks Deno's
resource sanitizer, so this is not a leak/soak qualification.

Fresh comparisons cover **40 atlas pages**. All decoded channels match Deno exactly; the **15**
representative pages also match the sealed F0 pixels. PNG CRCs are checked through the independent
decoder. Same-process raw double rendering and repeated cold/warm whole-bake byte canaries pass. The
fallback tolerance remains 2/255 per channel and at most 0.5% differing pixels **per cell**; blank
atlas space cannot dilute it. A failing comparison writes expected/actual/diff PNGs.

The review image groups **Deno / Node / thresholded difference**, four directions per group. Rows
are pixel 1x/2x/4x, explicit mirroring, then asymmetric pixel/cel/painterly/clean. It compares the
first idle frame; the structural/numeric tests and atlas comparisons cover the remaining cases.

## Installed layout and failures

The [opt-in Tauri launcher](../apps/studio/src-tauri/src/qualification.rs) resolves
`renderer-runtime` through `app.path().resource_dir()`. Its child has an **empty PATH**, a fresh
working/temp/data directory and the existing owned-process startup gate. It invokes only bundled
Node and compiled JavaScript, with addon, Vulkan loader, WGSL, canonical mesh, clip data and PNG
fixtures in resources. No source files or development `node_modules` are installed. The proof has no
editor window; GUI/CLI cutover remains F4.

The [delivery probe](../tools/qualification/delivery.mjs) exercises completed bakes, carried
assertions, actual native device destruction after a queue submission, unavailable adapter after
removing the packaged loader, missing addon, abrupt owner death during real rendering and retry. It
compares every prior bake byte after failures. Device-loss tests require `device-lost` with
`retryable: true`, no done event and no completed failed-attempt manifest. They simulate destruction
through the real API, not a physical driver reset.

The experiment exposed two production compatibility defects, now fixed: GIF namespace selection
across CJS/ESM, and bake dropping a renderer error's code/retryability. Fixture URL helpers now use
the platform conversion for installed paths containing spaces/Unicode. No manifest schema, accepted
assets or sidecar protocol changed. The final Deno suite passes **839 tests, 44 steps**, with five
existing ignored real-model/engine lanes; the focused path checks pass 29 tests.

## Binary and notice audit

- `webgpu` metadata says MIT; its actual shipped license is **BSD-3-Clause**. The copied text is
  authoritative for this audit. Its JavaScript loader needs no `debug`, `ms` or `@webgpu/types` at
  execution time.
- The tested Dawn build cannot find the system Vulkan loader by basename on this Windows host
  (`DynamicLib.Open: vulkan-1.dll Windows Error: 87`). Bundling the pinned official Vulkan loader
  beside the addon resolves it. Its MIT/Apache-2.0 notices are included.
- The Vulkan installer excludes Microsoft's FXC/DXC DLLs and WebView2 bootstrapper. PE imports still
  require installed Windows graphics drivers and VC++ runtime DLLs, including `MSVCP140`,
  `MSVCP140_ATOMIC_WAIT`, `VCRUNTIME140` and `VCRUNTIME140_1`. A compiler installation is not a
  runtime provisioning strategy; a clean-machine prerequisite check remains necessary.
- Node's complete shipped license, bundled JavaScript license files, standard-library license,
  SpriteBook license/notice and fixture catalog metadata are retained.
- **Redistribution clearance remains open:** the npm addon does not provide a complete inventory of
  its statically linked third-party notices. The audit also exposes existing `pako` 2.2.0's **MIT
  AND Zlib** declaration and Node's bundled native notices against the repository's strict
  allowlist. Resolve the actual dependency/policy mismatch explicitly before distribution; do not
  infer clearance from a top-level MIT/BSD label. See the [BOM](../docs/dependencies.md).

Upstream references: [binding and lifetime contract](https://github.com/dawn-gpu/node-webgpu),
[exact addon build recipe](https://github.com/dawn-gpu/node-webgpu/blob/9e52a4b5eefbc08188fe4b7f9d96d2dd7040e513/build/build.js),
[Node release checksums](https://nodejs.org/dist/v24.22.0/SHASUMS256.txt),
[Vulkan runtime distribution](https://vulkan.lunarg.com/sdk/home).

## Reproduction and remaining gates

From a Windows x64 checkout with the pinned Deno control and Rust build tools, preserve the F0
workspace and use a **new** output directory each time:

```powershell
npm.cmd ci --ignore-scripts --prefix tools/qualification
node tools/qualification/build.mjs .render-bench/f2/my-payload .render-bench/f0/legacy-control/workspace
node tools/qualification/measure.mjs .render-bench/f2/my-payload/runtime .render-bench/f2/my-measurements vulkan
deno run --config deno.json --allow-read --allow-write tools/qualification/compare.ts .render-bench/f2/my-measurements .render-bench/f0/legacy-control
```

The builder deliberately rejects unqualified host targets. It uses Deno **at build time**, not in
the installed Node runtime. F4 replaces this temporary compiler/tooling path. Benchmark failure is
terminal and its artifacts remain; image suites are never automatically retried.

F2 remains open for native Windows ARM64, macOS ARM64/x64, Linux Vulkan/lavapipe, clean-machine
installation/prerequisites and complete native notice clearance. No additional hardware/runner has
been available in this session. A generic upstream build matrix is not evidence for these targets.
Do not mark the whole milestone or a production renderer promotion complete from the Windows result.
Preserve the Tauri/TypeScript/in-place decision while collecting the remaining evidence; a
whole-core rewrite would not solve these gates.
