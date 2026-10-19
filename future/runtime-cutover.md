# Node runtime cutover

F4 migrates this repository in place. The TypeScript core/CLI, Tauri/React editor, manifest formats,
WGSL and feature boundaries are retained. Main now builds and runs on Node **24.22.0**, with pinned
Dawn **0.6.2**. No supported development, test, CI or application entrypoint requires Deno. F4's
real-model setup exit gate remains open pending the explicit roadmap decision below.

## Implemented path

- Locked npm workspaces emit JavaScript and declarations; tests exercise emitted modules, with a
  separate TypeScript check. Node's resource guard catches referenced handles; descriptor/process
  regressions cover boundaries its inventory cannot see. No force-exit or global runtime shim.
- All package groups retain their algorithms, importer normalization, core retargeting, reversible
  persistence, catalog gates, VRAM ownership, palette ordering, AOV packing and exporter contracts.
- A small shared Rust component handles kernel file locks and process trees. Product behavior stays
  TypeScript. The installed CLI and Tauri resolve owned Node/uv/assets by absolute resource paths.
- The payload retains compiled packages and the exact production dependency tree. This preserves
  OBJ/CJS and decoder assets; the importer is included. `@spritebook/image` supplies the qualified
  PNG writer and PNG/JPEG ndarray IO without Sharp/libvips. Three security patches are recorded in
  the BOM; other production transitive pins retain the legacy versions.
- Owned uv uses frozen resolution, normal wheel installation and writable, lock-specific user
  environments. Python bytecode is disabled in installed resources. Model weights and optional
  environments are never copied from the builder. Hub credentials stay on their HTTPS origin and are
  omitted at CDN redirects.
- Vite excludes Rust/generated runtime output from watching and uses a bounded optimizer list. The
  forced cold server starts in 599 ms and serves the source entry; real WebView/Tauri projection,
  cancellation/retry and editor ownership checks pass.
- CI uses Node on the existing OS/software-Vulkan lanes. Release execution builds candidates with
  owned runtimes and Windows NSIS packaging; publication waits for F7 qualification.

## Renderer evidence

The [machine-readable receipt](qualification/node-cutover-windows-x64.json) records 46 fresh paired
processes using the archived F1 control and the actual production Node package tree. Three trials
per supersample alternate runtime order; cold means an empty frame cache, with OS/driver caches left
alone. Warm cache hits are 100%. Fixed fixtures include the textured rig, clips, attachment, alpha,
width 100, non-square cells, mirroring and all four styles.

| Supersample | Deno cold median | Node cold median | Cold change | Node warm median |
| ----------- | ---------------: | ---------------: | ----------: | ---------------: |
| 1?          |          4.325 s |          3.789 s |     ?12.39% |          2.075 s |
| 2?          |          5.906 s |          5.018 s |     ?15.04% |          2.116 s |
| 4?          |         11.127 s |          9.599 s |     ?13.74% |          2.087 s |

All **40/40** atlas pages match decoded pixels exactly; all **15/15** comparisons to sealed F0 pages
match. Frame layout, pivots, mirroring and AOV declarations match exactly. PNG bytes differ because
F4 promotes the qualified native-zlib encoder. Same-runtime cold/warm/repeated hashes remain stable.
The [review image](qualification/node-cutover-review.png) shows legacy / Node / diff columns; it was
inspected as an image, with no golden or tolerance changed.

Renderer **0.6.0** creates a new cache namespace over Node, platform/architecture, Dawn, PNG/zlib,
backend and exposed adapter/driver fields. Old bakes and exports remain readable; no old cache hit
is counted as a successful Node render.

## State and installed-environment checks

- Preserved F0 workspace copies retain immutable IDs, accepted/source/rig/bake bytes, and readable
  history through query, rename, undo and redo. Every old exporter metadata file and decoded PNG
  survives re-export. Future character schema versions refuse honestly. The archived F1 Deno release
  reopens both the untouched and Node-edited copies. The original control remains sealed.
- Existing crash/concurrent-writer tests and an added ENOSPC boundary check recover a coherent prior
  or durable pending state. The runtime builder recovers interrupted directory replacement; this is
  separate from an operating-system installer upgrade guarantee.
- The initial 6,129-file copied payload passes version/catalog/doctor, OBJ import in its intact CJS
  layout, styled/AOV baking and all four exporters outside the checkout under a Unicode path with an
  empty PATH. Final installer/failure evidence is added after its dedicated run.
- A fresh user profile and uv cache initialize the base sidecar in **10.3 s** with an empty PATH,
  announce the v1 handshake and shut down cleanly. The machine's managed Python 3.11.15 is reused;
  this is not a whole clean-machine claim. Real, registry-installed U?-Net prep passes, as do
  sidecar death/retry and doctor handshake checks.

## Remaining gate

The existing real TRELLIS.2 and UniRig environments/source are absent on this machine. Their old
preparation relied on retired, untracked spike directories. TRELLIS.2 still has an undeclared,
manually gated DINOv3 conditioner and evaluation-only/unlicensed CUDA components documented in the
[BOM](../docs/dependencies.md) and [sidecar setup](../sidecar/README.md). Current auth access is
available; access alone does not solve reproducible provisioning or stack clearance. No model
substitution, license exception or silent cloud fallback was introduced.

The current roadmap explicitly keeps minimum existing-model provisioning in **F4-T4**. Until the
maintainer changes that scope or the gate is resolved, F4 is **open**, even though the Node package,
renderer, CLI and desktop cutover is implemented. This is distinct from F7's already agreed native
Mac/ARM/Linux, signing, notices, clean-machine prerequisites, engine, accessibility and soak gates.

## Reproduction and preserved controls

Normal source checks: `npm ci --ignore-scripts`, `npm run build`, `npm run check`, `npm test`. `npm
run build:runtime` seals `.build/runtime`; `node tools/runtime/check.mjs .build/runtime
<new-results> --gpu` checks an outside-checkout copy. `npm run build:desktop` builds the Windows
candidate. The [README](../README.md) explains development prerequisites.

`tools/proofs/runtime-workspace.ts` checks preserved-copy conversion/rollback; `runtime-measure.mjs`
and `runtime-compare.ts` reproduce the paired renderer experiment. These opt-in control comparisons
require the archived legacy build and never run Deno in the current checkout. F2-only adapters,
import maps and lean-tree release tooling have been retired; retrieve them from **7f098c6** for
historical reproduction. F1's pinned source archive is **b201f85**. Local evidence retains:

- F0: `.render-bench/f0/f0-windows-x64-vulkan.zip`, SHA-256
  `a1efcb0956fd52c415eefb1efa6ce467d854defa18b7b1fc5ab12bec3e8dd9f3`.
- F1 source: `.render-bench/f4/legacy-F1.zip`, SHA-256
  `eb51889ff4e3df1ea109b28dce2de4e7b420d2922aca259abef42492a941b785`.
- Pinned Deno 2.9.2 reference: `.render-bench/f4/legacy-runtime/deno.exe`, SHA-256
  `a5270c2bb75a2ec12fef53185730327267d9e9fe6be6a962c5d1d5a050f93c88`.
- Paired measurements/images: `.render-bench/f4/paired-2/`; conversion: `conversion-3/`; native
  desktop: `desktop-dev-proof/`, `desktop-ownership.log`; real prep: `rembg-check.log`.

Nothing was pushed or published, and hosted CI was not dispatched.
