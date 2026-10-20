# Node runtime cutover

F4 migrates this repository in place. The TypeScript core/CLI, Tauri/React editor, manifest formats,
WGSL and feature boundaries are retained. Main now builds and runs on Node **24.22.0**, with pinned
Dawn **0.6.2**. No supported development, test, CI or application entrypoint requires Deno. **F4 is
complete**, including its retained real-model provisioning/licensing and installed-workflow gate. F7
release qualification is next.

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

The final Windows Node checks cover **903 cases: 896 pass, seven optional lanes are skipped**.
Twenty-three checks initially failed because an older source sidecar locked its executable; all pass
in an isolated sidecar environment (31 focused passes/one weight-gated skip). No unresolved failure,
golden change or image-suite automatic retry remains. Python selftest passes 516 assertions;
types/lint, real installed U²-Net/model workflow and native Tauri checks pass. The earlier 899-case
cutover run measured **91.75%** line coverage; that measurement was not repeated for the model
provisioning changes.

## Renderer evidence

The [machine-readable receipt](qualification/node-cutover-windows-x64.json) records 46 fresh paired
processes using the archived F1 control and the actual production Node package tree. Three trials
per supersample alternate runtime order; cold means an empty frame cache, with OS/driver caches left
alone. Warm cache hits are 100%. Fixed fixtures include the textured rig, clips, attachment, alpha,
width 100, non-square cells, mirroring and all four styles.

| Supersample | Deno cold median | Node cold median | Cold change | Node warm median |
| ----------- | ---------------: | ---------------: | ----------: | ---------------: |
| 1x          |          4.325 s |          3.789 s |     -12.39% |          2.075 s |
| 2x          |          5.906 s |          5.018 s |     -15.04% |          2.116 s |
| 4x          |         11.127 s |          9.599 s |     -13.74% |          2.087 s |

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
- The final model-qualified NSIS candidate (`2fbfadf`) installs outside the checkout under a Unicode
  path. All **6,149** sealed runtime files verify. With an empty PATH and fresh user/Python/cache
  directories, the copied installed payload imports OBJ in its intact CJS layout, runs synthetic
  gen/pick, Track A rigging, core preview, 48-frame cold/warm baking (0/100% hits), styled/AOV
  asymmetric rendering and all four exporters. Model-root relocation, corrupt receipt refusal,
  missing Dawn/loader failures, owner termination after a rendered frame and retry pass. Prior
  accepted bake hashes remain unchanged.
- The actual installed Tauri app reports owned Node **24.22.0**, managed Python **3.11.16**,
  contract v1 and nine adapters, and reads the preserved roster/thumbnail/mesh/atlas through core.
  Its health action reports render/sidecar OK; screenshots were inspected. NSIS install and private
  uninstall both exit 0. No Vite server or checkout executable is used by the installed bridge.
- An initial fresh-profile base setup took **10.3 s**, reusing managed Python 3.11.15. Final Unicode
  runs download Python 3.11.16 into isolated directories and use normal wheel installation; this
  fixes Python 3.11's locale-decoded editable `.pth` import failure. Real, registry-installed U2-Net
  prep and sidecar death/retry also pass. These are fresh-profile checks on this developer machine,
  not a clean-machine prerequisite/signing claim.

## Existing model gate completed

The [model qualification receipt](qualification/model-workflow-windows-x64.json) and
[completed gate](model-provisioning-gate.md) record the real installed workflow. Complete catalog
versions `af44b45f.local1`/`36842e2b.local1` provision pinned sources and separate frozen Windows
environments through `models install`/`models setup`. Local decoder/conditioner resolution removes
hidden Hub fallback. MIT DRTK and the source-traced O-Voxel replace the restricted rasterizers;
owned UniRig architecture data replaces the restricted historical OPT config. DINOv3's exact custom
agreement remains separately accepted. Native model environments and their full notices remain
user-installed, outside the application payload; no license exception or silent cloud fallback.

With fresh caches, empty PATH, managed Python 3.11.16 and the installed CLI, real U²-Net prep,
generation/pick, retexture, UniRig, core preview, 144-frame styled/AOV bake and four exporters pass.
Cold/warm bake CLI times are 21.7/6.7 s with 0/100% cache hits. Each clip/direction has six distinct
frames. The [review sheet](qualification/model-workflow-review.png) was inspected. The sample keeps
two stretch and two unmapped-joint advisories, with explicit rig acceptance; it is not a new default
or a claim that model output needs no review.

uv/HF/Transformers offline modes and a Python non-loopback socket guard record zero inference
outbound attempts. A failed Python setup preserves verified weights; worker death/retry and
prepared-source corruption/repair preserve accepted mesh/bake hashes. The installed Tauri bridge
reports Node/GPU/sidecar health and reads that real workspace's mesh/thumb/atlas. Cold Unicode-path
qualification also fixes Python editable loading and Triton/TinyCC path handling without changing
wheel binaries or requiring an external compiler.

The maintainer's **F4-T4** gate is satisfied. Native Mac/Windows ARM64/Linux, signing, notices,
clean-machine prerequisites, installer upgrades, engine imports, accessibility and soak remain F7
release gates. Fresh-profile execution on this developer machine does not close those gates.

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
- Paired measurements/images: `.render-bench/f4/paired-2/`; conversion: `conversion-4/`; native
  desktop: `desktop-dev-proof/`, `desktop-ownership.log`, `desktop-installed-final-proof/`;
  installed workflow: `installed-final-2/`; real prep: `rembg-check.log`; suite:
  `final-node-suite.log`.
- Final model installation/workflow/recovery: `.render-bench/f4/installed-model-proof/`; final
  copied runtime: `model-final-runtime/`; Node suite/rechecks: `model-final-node-suite.log` and
  `model-isolated-sidecar-tests.log`; cold native regression: `triton-native-regression.log`.

Nothing was pushed or published, and hosted CI was not dispatched.
