# Node renderer qualification

Evidence date: **2026-10-19**. This is the bounded **F2** experiment, using the preserved
[F0 control](baseline.md) and the existing renderer, animation, style and pack modules. Production
Studio and the CLI still use Deno. The Tauri renderer-proof build is an isolated launcher, not a
migrated editor or a replacement application.

**Recommendation: retain Node/Dawn and qualify the Node PNG writer for promotion in F4.** Windows
x64 Vulkan passes the measured image and performance gates. The evidence does not justify a Rust
render worker. Other hardware, clean-machine delivery and complete redistribution clearance remain
gates; this report does not grant a support claim or a license-policy exception.

The checked-in [measurement and artifact receipt](qualification/windows-x64.json) contains exact
pins, hashes, timings, memory observations and installed results. The
[review image](qualification/windows-x64-review.png) retains the visual comparison. Large runtime,
installer and bake artifacts stay under the ignored `.render-bench/f2/` tree.

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
| 1x            |   4.756 s |   3.992 s |      -16.1% |   2.580 s |   2.083 s |
| 2x            |   6.390 s |   5.457 s |      -14.6% |   2.571 s |   2.073 s |
| 4x            |  11.745 s |  10.251 s |      -12.7% |   2.568 s |   2.126 s |

**Result: pass without a performance exception.** There are 46 process runs: cold/warm repetitions
for the three-clip workload, all four styles on the asymmetric fixture, and explicit mirroring. The
representative workload is **96 frames**: idle/walk/action, four samples, eight directions, 100x128
cells, 32 px/m and padding 16. The accepted textured canonical mesh is copied from F0; it is a
mechanical fixture, not evidence of new model quality or likeness.

These are the final UTF-8-manifest runtime's measurements, repeated after installed-path fixes. The
earlier native-PNG trial also passed; both raw runs are retained. The final runtime receipt is from
`de1768d`, and the installed Tauri launcher's source is `8ac908b`. The renderer/codec bundles are
unchanged between those builds.

Reports retain per-clip render/readback/PNG throughput, sampled process RSS and whole-GPU memory.
RSS samples are taken every 20 ms; GPU memory every 100 ms includes the desktop and other GPU users.
They are observed peaks, not exact process VRAM allocations or admission floors.

| Sampling | Deno max RSS | Node max RSS | Deno render/readback/PNG | Node render/readback/PNG |
| -------- | -----------: | -----------: | -----------------------: | -----------------------: |
| 1x       |    446.0 MiB |    357.2 MiB |                136.5 fps |                202.6 fps |
| 2x       |    431.6 MiB |    444.9 MiB |                 71.0 fps |                145.3 fps |
| 4x       |    737.3 MiB |    704.7 MiB |                 27.9 fps |                 73.7 fps |

RSS is the largest sampled process value across the three cold trials. Throughput is the median of
96 frames divided by the sum of their three measured clip-render intervals; it excludes retargeting
and atlas packing. Whole-GPU use ranges from 1784–2009 MiB for Deno and 1784–1828 MiB for Node over
these trials. These values do not establish model VRAM budgets.

## Image and structural gates

**110 original assertions run on Node**, including exact framing/scale/pivots, alpha and material
behavior, attachment placement and motion, retarget numerics, width-100 padded versus row-by-row
readback, palette membership, AOV encoding/layout, mirror normal handling and style goldens. The
runner preserves their expectations; it does not reproduce their implementation. It lacks Deno's
resource sanitizer, so this is not a leak/soak qualification.

Fresh comparisons cover **40 atlas pages**. All decoded channels match Deno exactly; the **15**
representative pages also match the sealed F0 pixels. PNG CRCs are checked through the independent
decoder. Same-process raw double rendering and repeated cold/warm atlas-byte canaries pass. The
fallback tolerance remains 2/255 per channel and at most 0.5% differing pixels **per cell**; blank
atlas space cannot dilute it. A failing comparison writes expected/actual/diff PNGs.

The review image groups **Deno / Node / thresholded difference**, four directions per group. Rows
are pixel 1x/2x/4x, explicit mirroring, then asymmetric pixel/cel/painterly/clean. It compares the
first idle frame; the structural/numeric tests and atlas comparisons cover the remaining cases.

The environment adapter must return an ordinary, freshly backed `Uint8Array` for file reads.
Returning Node's `Buffer` made existing `.slice()` calls return views; typed-array alignment then
corrupted sampled poses. The original numeric and render assertions caught this. F4 must preserve
the readers' copy/alignment contract explicitly rather than relying on the proof adapter.

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

**Installed result: pass on Windows 11 Pro 10.0.26200 x64.** A fresh, unsigned NSIS proof installer
was executed into a private temporary directory containing spaces and **Ω**. All **118** runtime
files matched their sealed hashes. From that installed resource tree, the 96-frame bake and **110**
carried checks passed with no system runtime on PATH. Both device-loss cases retained a classified
retryable error. Removing the addon or loader produced exit **1** and the expected diagnostic;
neither published a completed bake. Killing the owner after real PNG frames appeared removed its
owned Node child. The subsequent 4x bake completed, and every prior accepted bake file, including
its manifest, remained SHA-256 identical. The private installation was then uninstalled; raw results
and the installer remain locally available.

The module audit observed bundled Node, Dawn and Vulkan loader paths, plus the VC++ runtime DLLs
under Windows `System32`. This proves execution without compiler executables or a checkout; it does
not prove provisioning on a clean Windows machine without those runtime prerequisites.

The tested NSIS installer is **33,397,981 bytes** at
`.render-bench/f2/tauri-target/release/bundle/nsis/SpriteBook Renderer Proof_0.9.0_x64-setup.exe`.
Its SHA-256 and installed launcher hash are in the checked-in receipt. Raw delivery results are
retained at `.render-bench/f2/installed-results/`; the sealed runtime and complete file inventory
are at `.render-bench/f2/qualified-utf8/`. Installer and modified runtime are unsigned experimental
artifacts, with release clearance still open.

Two installed-path findings are part of the delivery design:

- On this code-page-1252 host, Dawn's ANSI DLL path handling fails under an installation directory
  containing **Ω**, even with the loader beside the addon. The builder merges a process-local UTF-8
  manifest setting into the app-owned Node executable, retaining its original settings and recording
  input/output hashes. This uses the Windows SDK's `mt.exe` at build time; installed execution needs
  no SDK. Release signing must follow the modification. No system locale or executable is changed.
  Paths beyond Win32 `MAX_PATH` remain unqualified.
- Tauri's default event loop exited with OS code 0 even when the worker and saved report said 1. The
  proof now uses its returning event loop and explicitly propagates the recorded worker code.
  Missing-addon and missing-loader checks assert the actual OS status as well as the diagnostic.

The Unicode workaround follows Microsoft's
[process UTF-8 manifest guidance](https://learn.microsoft.com/en-us/windows/apps/design/globalizing/use-utf8-code-page).
The pinned Dawn source uses
[ANSI module-path discovery](https://dawn.googlesource.com/dawn/+/77f9a9aa5f7180958480de17680c61a84c006842/src/dawn/common/SystemUtils.cpp)
and
[ANSI DLL loading](https://dawn.googlesource.com/dawn/+/77f9a9aa5f7180958480de17680c61a84c006842/src/dawn/common/DynamicLib.cpp).

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

For the resource-layout proof, install the Studio npm dependencies and run the opt-in Tauri build
from the same repository. The Windows SDK manifest tool must be available at the builder's pinned
path, or set `SPRITEBOOK_MT_EXE` to its explicit path. From the repository root:

```powershell
$proofConfig = (Resolve-Path .render-bench/f2/my-payload/tauri.conf.json).Path
$env:CARGO_TARGET_DIR = Join-Path (Get-Location).Path '.render-bench/f2/tauri-target'
Push-Location apps/studio
node node_modules/@tauri-apps/cli/tauri.js build --ci --config $proofConfig --features renderer-qualification -- --locked
Pop-Location
```

Install that distinct proof product in a disposable directory, then run:

```powershell
node tools/qualification/delivery.mjs '<installed-directory>/spritebook-studio.exe' '<new-absolute-results-directory>'
```

The builder deliberately rejects unqualified host targets. It uses Deno **at build time**, not in
the installed Node runtime. F4 replaces this temporary compiler/tooling path. Benchmark failure is
terminal and its artifacts remain; image suites are never automatically retried.

## Deferred platform checks

The maintainer confirmed **Windows x64 only for F2 on 2026-10-19**. Native Windows ARM64, macOS
ARM64/Intel and Linux execution move to **F7-T1/T2**, before support is advertised for those
artifacts. Clean-machine prerequisites and complete native notice clearance also remain release
gates. Production renderer promotion is F4 work.

GitHub Actions can build and run non-GPU checks on its
[standard OS runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners).
The repository already declares those source-test lanes and a Linux Mesa lavapipe lane; F4-T4 must
port them to Node. This session has not dispatched remote CI or qualified the Node addon there.
Lavapipe can provide Linux software-rendering smoke/structural evidence, with its backend recorded;
it cannot establish hardware performance or desktop behavior.

Actual hardware checks need a suitable adapter, rather than a personally owned machine specifically.
[GitHub's larger runners](https://docs.github.com/en/actions/reference/runners/larger-runners)
include GPU options and an Apple Silicon option with GPU acceleration; availability, billing and the
application's adapter must be verified before use. A configured GPU runner or a supplied native
machine can run the same workload. Mac/Windows ARM64/Linux installed paths, hardware pixels,
performance and desktop behavior stay unverified until those runs happen. No paid runner or new CI
infrastructure is provisioned in F2.
