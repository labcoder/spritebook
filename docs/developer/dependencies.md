# SpriteBook — dependencies (bill of materials)

**Rule: check this file before adding any dependency; new deps get a row here in the same PR.**
Status marks: **✓** license checked for the stated component/version · **std** established choice,
re-confirm at pin time · **⚠** gate open — verify before integration. Rows include selected
dependencies, historical investigations and proposed candidates; presence here is not evidence that
a model or package ships. Current JavaScript resolution lives in `package-lock.json`, Rust in the
Cargo locks, and model Python dependencies in the frozen sidecar locks. The
[model inventory](../user/models.md) identifies the integrated catalog choices.

**License posture:** everything _bundled_ is MIT / Apache-2.0 / BSD / ISC / OFL / CC0. AI model
weights are never bundled — catalog entries installed on demand behind license/territory/VRAM gates.
No third-party copyleft in the shipped binary path (GPL tooling allowed only as isolated sidecar
subprocesses). **SpriteBook's own license is AGPL-3.0-only with an output exception + attribution
request (D-019)** — permissive deps combine into an AGPL work cleanly, so the bundling rules above
are unchanged.

## Runtime & shell

| Dependency      | Role                                                        | License                                       | Pin                  |
| --------------- | ----------------------------------------------------------- | --------------------------------------------- | -------------------- |
| Node LTS        | Core/CLI runtime; installed application owns its executable | MIT plus bundled notices                      | 24.22.0              |
| zod             | Manifest/catalog/runtime validation                         | MIT                                           | 4.6.7                |
| Tauri           | Desktop shell, selected by D-005 and retained by D-041      | MIT/Apache-2.0                                | lock-pinned 2.11/2.6 |
| Dawn (`webgpu`) | Native headless WebGPU                                      | shipped BSD-3-Clause text; native audit below | 0.6.2                |

F4 uses a locked npm workspace and compiled JavaScript for the existing TypeScript packages.
Build/test dependencies below are not bundled in application resources:

| Dependency                                               | Role                                                                   | License           | Pin                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------- | -------------------------------------------- |
| TypeScript                                               | Compile JavaScript/declarations and separately check source/tests      | Apache-2.0        | 7.0.2, retained from Studio                  |
| `@types/node`                                            | Node API declarations                                                  | MIT               | 24.19.2                                      |
| `@std/assert` / `@jsr/std__internal`                     | Existing assertions through JSR's npm-compatible registry              | MIT               | 1.0.19 / 1.0.12, retained from the Deno lock |
| `@biomejs/biome`                                         | Development linter                                                     | MIT OR Apache-2.0 | 2.5.15                                       |
| Vite                                                     | Studio development server and production web build                     | MIT               | 8.1.6                                        |
| `@vitejs/plugin-react`                                   | Studio's existing React integration, made compatible with Vite 8       | MIT               | 6.0.1                                        |
| `dprint`                                                 | Retain the existing formatting engine without executing Deno           | MIT               | 0.64.0                                       |
| `@dprint/typescript`, `@dprint/json`, `@dprint/markdown` | Locally installed formatter Wasm plugins; no first-run plugin download | MIT               | 0.96.1 / 0.25.2 / 0.26.0                     |

The previous React plugin 5.1.4 declared Vite support only through 7, preventing a clean npm
workspace install with Vite 8. The
[upstream migration notes](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/CHANGELOG.md)
describe the compatible v6 integration. No Babel compiler plugin is enabled.

The shared native ownership crate uses lock-pinned `windows-sys` 0.61.2 (MIT/Apache-2.0) for Windows
job objects and `libc` 0.2 (MIT/Apache-2.0) for Unix process groups. Both already belonged to the
Tauri dependency graph; F1-T3 uses them to cancel owned CLI descendants and clean up on close.

F4's small `spritebook-lock` helper reuses **windows-sys 0.61.2** and **libc 0.2.189**
(MIT/Apache-2.0). It preserves kernel file locks across Node process death using `LockFileEx` or
`flock`, without moving workspace policy into Rust. Its Cargo lock is committed; development builds
need Rust, while installed applications include the compiled helper. No FFI package or timeout-based
replacement for F1's workspace locks is added.

F4 promotes F2's qualified renderer into `@spritebook/render` with pinned `webgpu` **0.6.2**. Its
npm metadata says MIT, but its actual `LICENSE.md` is **BSD-3-Clause** (Dawn/Tint); retain the
shipped text. The addon runs on an app-owned **Node 24.22.0** (MIT plus Node's bundled third-party
notices). Its npm transitives are `debug` (MIT), `ms` (MIT) and `@webgpu/types` **0.1.74**
(BSD-3-Clause); the deployed loader imports none of them. Windows shader DLLs and native transitive
notices require an explicit artifact audit before a shipping claim; do not copy the entire npm
distribution on the strength of its metadata label.

The Windows Vulkan proof bundles the **LunarG Vulkan Runtime 1.4.341.0** x64 loader (MIT/Apache-2.0,
with its complete `VulkanRT-License.txt`). Its official Components archive is SHA-256 pinned in the
proof builder. Dawn needs this loader beside the addon: its current Windows search path fails to
load the system copy by basename. The Vulkan payload excludes FXC, DXC and their DLLs; Direct3D 12
experiments with DXC are separate from that artifact. PE imports also require the Microsoft VC++
runtime on the machine; it is not silently copied from Visual Studio.

The private Direct3D 12 experiment adds the npm distribution's `dxcompiler.dll`,
`dxcompiler-LICENSE.TXT` and `dxcompiler-ThirdPartyNotices.txt`. The shipped DXC license is **LLVM /
University of Illinois-NCSA**, outside the strict bundling allowlist. These files are excluded from
the Vulkan installer; their hashes and measured results are recorded in
[`future/qualification/windows-x64.json`](../../future/qualification/windows-x64.json). No Direct3D
12 redistribution clearance or installed-artifact support claim follows from the private run.

The Windows proof merges a process-local UTF-8 `activeCodePage` into its **app-owned copy** of
Node's PE manifest, using the Windows SDK's build-time `mt.exe`. Dawn's ANSI loader otherwise cannot
resolve a Unicode installation directory on the tested code page 1252 host. Upstream manifest
settings are retained; input/output hashes and the merged manifest are recorded. This modification
invalidates upstream executable signing, so release signing must happen afterward. No system
executable, registry code page or locale is changed.

The shared `@spritebook/image` PNG writer uses Node's built-in `zlib` and CRC32, retaining
`fast-png` decoding. F4 promotes the byte-qualified F2 writer into production. The copied Node
license includes its native third-party notices. The artifact audit also exposes the existing `pako`
2.2.0 transitive declaration **MIT AND Zlib**, beyond this document's strict bundling allowlist.
Release clearance must resolve that policy mismatch and the prebuilt addon's complete static
dependency notices; an internal renderer experiment is not clearance to distribute.

## Core render, style, pack

| Dependency        | Role                                                            | License      | Status                              |
| ----------------- | --------------------------------------------------------------- | ------------ | ----------------------------------- |
| WGSL shader stack | NPR passes                                                      | ours         | —                                   |
| fast-png          | PNG decode                                                      | MIT          | std                                 |
| jpeg-js           | glTF JPEG byte decode/encode, shared image boundary             | BSD-3-Clause | 0.4.4, existing importer dependency |
| ndarray           | Strided glTF image arrays                                       | MIT          | 1.0.19, retained legacy pin         |
| `@types/ndarray`  | Development declarations only                                   | MIT          | 1.0.14                              |
| pixelmatch        | golden diffs                                                    | ISC          | std                                 |
| OKLab math        | perceptual quantize                                             | ours (TS)    | implemented in core/style           |
| maxrects-packer   | atlasing                                                        | MIT          | std                                 |
| gifenc            | contact-sheet artifacts only (player is interactive, never GIF) | MIT          | std                                 |
| Mesa lavapipe     | CI software Vulkan                                              | MIT          | std, CI-only                        |

The shared image package also supplies glTF-Transform's byte-only `ndarray-pixels` boundary through
an npm override. It uses existing `jpeg-js` **0.4.4** (BSD-3-Clause), `ndarray` **1.0.19** (MIT) and
development-only `@types/ndarray` **1.0.14** (MIT). This avoids bundling Sharp/libvips; PNG/JPEG
inputs normalize to RGBA8, including palette transparency, packed samples and 16-bit high bytes.
Unsupported optional encodings remain encoded when an upstream optimization cannot decode them. The
codec and ndarray notices are retained in the installed package tree.

The production transitive security overrides are Ajv **8.18.0** (MIT), fast-uri **3.1.9**
(BSD-3-Clause) and DOMPurify **3.4.17** (Apache-2.0 option selected). The October 2026 dependency
review also pins Zod **4.6.7** and Vite **8.1.6** for the
[Zod collection-size validation advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
[Vite Windows editor-launch advisory](https://github.com/advisories/GHSA-587h-7wmj-h5pm) and
[fast-uri URI normalization advisory](https://github.com/advisories/GHSA-w74x-v6f9-j3xg). These
retain the current major versions and Vite's 8.1 maintenance line. Audit results can change; run
`npm audit` against the current lock before a release. The compiled runtime preserves the production
package tree rather than bundling CJS importer code that depends on private relative assets.
Development tools and source TypeScript are excluded.

## Importer border

| Dependency                  | Role                                         | License          | Status                                                                                                                                                      |
| --------------------------- | -------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| glTF-Transform              | all glTF surgery                             | MIT              | std; pinned ^4.4.1 (byte-determinism)                                                                                                                       |
| draco3dgltf / meshoptimizer | decode compressed uploads (exact npm names)  | Apache-2.0 / MIT | std; ^1.5.7 / ^1.2.0                                                                                                                                        |
| three (FBXLoader only)      | FBX ingestion — **interim per D-020**        | MIT              | ^0.185.1; parser only, bridged into glTF-Transform Documents; no DOM/renderer touched                                                                       |
| **ufbx**                    | FBX ingestion — target                       | MIT              | **blocked**: no npm package/wasm binding exists (verified 2026-07-13, D-020); no Autodesk code; Godot 4.3+ default. Revisit when a maintained binding lands |
| obj2gltf                    | OBJ ingestion                                | Apache-2.0       | std; ^3.2.0                                                                                                                                                 |
| mikktspace (wasm)           | tangents at render prep                      | MIT              | std                                                                                                                                                         |
| @pixiv/three-vrm            | VRM conventions reference (VRM 0.x faces −Z) | MIT              | std, reference only                                                                                                                                         |

**Rejected: FBX2glTF.** Code BSD-3, but binaries embed the proprietary Autodesk FBX SDK under the
Autodesk License and Services Agreement (no redistribution). ✓ verified. Never bundle.

## AI sidecar

The installed runtime includes **uv 0.12.10** (MIT OR Apache-2.0), with the pinned official release
archive and both license texts. It creates Python environments in user-writable application data;
Python, wheels, model weights and backend code are provisioned on demand, never copied from a
builder's environment. Runtime archive checksums live in `tools/runtime/downloads.json`.

Hatchling **1.32.4** (MIT) builds only SpriteBook's own non-editable Python wheel. Model setup
prepares that package before publishing readiness, so inference can run with uv offline. Third-party
runtime dependencies still install from frozen prebuilt wheels; no user compiler is required.

| Dependency             | Role                              | License                                                     | Status                                                                                                                                                              |
| ---------------------- | --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| uv                     | Owned Python environment launcher | MIT OR Apache-2.0                                           | 0.12.10; official archive and license hashes pinned                                                                                                                 |
| Python 3.11+ / PyTorch | runtime                           | PSF / BSD-3                                                 | std                                                                                                                                                                 |
| rembg                  | background removal                | MIT                                                         | std; **per-weight**: u2net.onnx **✓ verified Apache-2.0** (2026-07-19, catalog entry `rembg-u2net`, hash-pinned); verify every future weight as it becomes an entry |
| onnxruntime (CPU)      | rembg inference                   | MIT                                                         | std; sidecar env only (uv-managed), CPU build — no CUDA requirement for imageprep                                                                                   |
| ajv (npm, core-side)   | paramsSchema validation           | MIT                                                         | std; exact-pinned; validates adapter JSON Schemas in core BEFORE jobs reach the sidecar (D-009)                                                                     |
| Pose check v1          | A-pose advisory                   | ours (silhouette heuristic on rembg alpha — **no new dep**) | audit item 14                                                                                                                                                       |
| MediaPipe Pose         | optional pose-check upgrade       | Apache-2.0                                                  | later, catalog-installed extra                                                                                                                                      |

## Generation backends (catalog — installed on demand)

The table retains historical candidate screening as well as integrated choices. Check the
[current model inventory](../user/models.md) for what users can install; a candidate license label
does not clear its transitive runtime or establish native support.

| Backend          | License (model)           | Status                                                                                                                                                                                        |
| ---------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TRELLIS.2 4B** | MIT (weights)             | Windows DRTK path passes installed F4 qualification; see exact component terms below. Measured **3.01 GiB** at shipped defaults, 16.53 GiB at `lowVram=false`                                 |
| Pixal3D          | MIT plus DINOv3 terms     | Pinned cp311/Torch 2.8/cu128 SM86 NATTEN wheel and real NAF/native admission pass. Installed generation/rig/sprites, offline recovery and exact fresh-worker replay pass; see F4-T6 evidence. |
| TripoSplat       | MIT                       | ✗ **not applicable**: emits gaussians, not a mesh (invariant 4)                                                                                                                               |
| Hunyuan3D 2.x    | Tencent Community License | ✗ **excludes EU/UK/KR** — territory carve-out; only ever a user-installed gated extra, never a default                                                                                        |
| TripoSG          | MIT (repo only)           | ✗ `NOTICE` discloses HunyuanDiT + FlashVDM (Tencent community licences) and BRIA RMBG-1.4; shape-only                                                                                         |
| Step1X-3D        | Apache-2.0                | ✗ source builds (`custom_rasterizer`, `differentiable_renderer`, PyTorch3D-from-git); Linux-only. **Best-licensed candidate — revisit if it ships Windows wheels**                            |
| Direct3D-S2      | MIT                       | ✗ `torchsparse` builds from source; shape-only                                                                                                                                                |
| `fixture-gen`    | MIT (ours)                | ✓ weightless, CPU, all platforms — the reason macOS/win-arm64 degrade rather than break                                                                                                       |

### Selected TRELLIS.2 Windows runtime

The optional environment is frozen in [sidecar/uv.lock](../../sidecar/uv.lock), with
[source/archive and notice pins](../../sidecar/runtimes/trellis2-win.json). Third-party CUDA wheels
are downloaded into the user's environment, never application resources.

| Artifact                          | Role and terms                                      | Evidence/delivery                                                                                                                                                                |
| --------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DRTK 0.1.0+cu128torch2.8          | UV rasterization, MIT (Meta)                        | Wheel includes MIT notice; source `facebookresearch/DRTK@c5a3e523`; build `cuda-wheels@1b9490ad`, job 66761030740                                                                |
| o-voxel-vb-ap 0.0.1+cu128torch2.8 | Dual-grid conversion, MIT source plus Eigen MPL-2.0 | Source `Trellis.2.drtk@200ba8cb`; build `cuda-wheels@7bc41ac7`, job 73822567578. Setup retains the omitted source notice, Eigen terms and source URL. External environment only. |
| cumesh 1.0 / flex_gemm 0.0.1      | Mesh cleanup/unwrap and sparse sampling, MIT        | Exact previously inspected community wheels at `visualbruno/ComfyUI-Trellis2@438fe4e2`; hashes retained in uv.lock                                                               |
| TRELLIS.2 / utils3d               | Official MIT source archives                        | Full commits/archive hashes in runtime recipe; no user-side Git/compiler. Keep upstream notices.                                                                                 |
| Adapted UV helper                 | DRTK pixel/barycentric boundary                     | [MIT attribution](../../sidecar/notices/uv-rasterizer-MIT.txt); adapted from `ComfyUI-TRELLIS2@3e696f2c`                                                                         |
| Triton Windows 3.7.1.post27       | MIT core with bundled toolchain notices             | Frozen wheel; own adapter reads Unicode environment values through Python and uses Triton's short-path helper for TinyCC arguments. No binary modification.                      |

The selected extra excludes `nvdiffrast`, `nvdiffrec_render` and the old untraced `o_voxel` wheel.
The first two carried NVIDIA evaluation-only terms; installing them outside the application did not
remove that restriction. Source preparation replaces both generation export and retexture UV
rasterization while retaining cleanup, original-surface projection, PBR sampling and measured model
defaults. The replacement passes native structural checks and real installed generation/retexture;
the [completed F4 gate](../../future/model-provisioning-gate.md) records exact qualification and
remaining F7 release checks.

The Windows admission check compiles a real sparse trilinear sampler and verifies all six PBR
channels with a cold Unicode-path cache. Setup and inference use a writable app-data Triton cache
unless explicitly overridden. This catches both the upstream ANSI environment decoder and TinyCC
include-path failure before model loading; no external compiler installation is required.

DINOv3's separately gated conditioner is declared in the complete `af44b45f.local1` catalog version,
alongside its exact agreement and an explicit acceptance gate. The authorized
`ea8dc2863c51be0a264bab82070e3e8836b02d51` snapshot's August 19, 2025 agreement has custom use/trade
and redistribution terms; it is not MIT. Its exact license SHA-256 is
`25d122eb8f5b880fd23c736fb6ea8018ee45c12237e00b8a86d14c653904999e`. That text omits the older public
website's “Built with DINOv3” clause. Preserve the applicable agreement and explicit acceptance; do
not substitute a blanket attribution or output-rights claim.

### Pixal3D Windows integration: recorded RTX 3090 scope

F4-T6 uses official TencentARC/Pixal3D source and MIT single-view checkpoints, with the same
separately gated DINOv3 snapshot/agreement described above. It is an optional user-provisioned
runtime, never an application-bundled model stack. The
[installed Windows qualification](../../future/qualification/pixal3d-windows-x64.json) passes; no
default or additional platform support is implied.

| Component                                          | Role and terms                                    | Selected path                                                                                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pixal3D                                            | MIT code/checkpoints; retain upstream NOTICE      | Official source `f7cf38429b0bd264f1995f0f8743a88b1c728b94`; model snapshot `b0cb2e1b794cab9aa0ac38a95d794a4d9337437f`; single-view files only                                                                                       |
| NAF                                                | Apache-2.0 source/checkpoint                      | `valeoai/NAF@37f2dfc180f2de53d98bd601109c0da0dd6b0f43`; local strict checkpoint loading, no unpinned Torch Hub                                                                                                                      |
| NATTEN 0.21.6                                      | MIT native neighborhood attention                 | cp311 / Torch 2.8 / CUDA 12.8 wheel; `cuda-wheels@ff5b37255bf073887f42c58fec49254699b3c8f6`, job 76701762292; native SM86 dispatch must pass                                                                                        |
| CUTLASS                                            | BSD-3-Clause kernels used by NATTEN               | Source `6b3e607b852f1543dc21323155a2ad71473c8642`; preserve its additional notice omitted from the wheel                                                                                                                            |
| Torch 2.8 / torchvision 0.23 / Transformers 4.57.3 | BSD-3 / Apache-2.0 plus bundled native notices    | Isolated frozen environment; upstream SDPA path, no FlashAttention source build                                                                                                                                                     |
| DRTK / CuMesh / flex-GEMM / O-Voxel                | Existing audited export/native dependencies       | Reuse the selected external TRELLIS stack and complete notices, including Eigen MPL-2.0; no evaluation-only NVIDIA rasterizers                                                                                                      |
| fast-simplification 0.2.0                          | MIT CPU quadric reduction; BSD-3 nanobind binding | Prebuilt cp311 Windows wheel, SHA-256 `c83791c8af1db1156753a3cb723e4eeffc2bf9fc46751894c90338d6fc7f779c`; wheel retains PyVista MIT license. CPU reduction/normals remove measured CuMesh replay drift; remesh/UV/PBR remain native |

The initial camera recipe uses upstream's explicit manual field of view, with its value recorded in
provenance. It does not install MoGe or BRIA matting; SpriteBook's own RGBA preparation remains the
input boundary. The model's actual DINOv3 dependency is governed by its own agreement even though
Pixal3D's upstream NOTICE still lists DINOv2.

The fast-simplification 0.2.0 source archive in the lock has SHA-256
`ed02ea6f4968ec98f963f2d3665dbafd0297ec12aea9e4d0a87c4b3c14d608a8`. Its `Simplify.h` retains Sven
Forstmann's 2014 MIT attribution; the wrapper license credits the PyVista developers (2017–2021).
The native binding uses
[nanobind's BSD-3-Clause terms](https://github.com/wjakob/nanobind/blob/master/LICENSE). These are
external runtime components; F7's binary-distribution notice review covers their complete upstream
notices as well as the wheel's root license.

### TripoSR spike dependencies (not shipped)

F4-T7's isolated evaluation environment uses MIT TripoSR root code/checkpoints with retained
Apache-2.0 attention-module notices, BSD OmegaConf 2.4.0, BSD/MIT scikit-image 0.26.0, MIT xatlas
0.0.11 and MIT ModernGL 5.12.0/glcontext 3.1.0, with the existing Torch/Transformers/rembg support
families. All installed artifacts are prebuilt wheels. The experiment substitutes CPU scikit-image
extraction for an unavailable torchmcubes wheel and fixes the reference texture baker's CUDA/CPU
handoff. These are recorded evaluation changes, not a catalog integration or new bundled dependency.
Exact resolved files remain in `.render-bench/f4/alternatives/triposr/runtime/uv.lock`; see the
[platform spike](../../future/model-platform-spike.md) for measurements and upstream pins.

## Rigging

| Dependency                            | Role                                               | License                                                                                | Status                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UniRig** (code + weights)           | Track B generic auto-rig                           | MIT                                                                                    | **✓** both GitHub LICENSE and HF model card; staged checkpoints → registry pins exact hashes                                                                                                                          |
| Make-It-Animatable                    | Independent humanoid rig candidate, not integrated | MIT outer code / Apache-2.0 declared MIA weights; **⚠ complete deployment unverified** | V1 required Mixamo template is gated; v2 adds Hunyuan backbone terms. No inference or runtime installed in this evaluation; see [screen](../../future/cpu-deformation-evaluation.md#mia-provisioning-screen).         |
| Canonical Track A body                | roster-fit rig                                     | ours, seeded from CC0 **Universal Base Characters** (Quaternius)                       | **✓ CC0 re-verified 2026-07-20** from the downloaded pack's License_Standard.txt; both bodies bundled at `packages/rig/bodies/` (65-joint UAL skeleton, full core, byte-stable builds via tools/roster/build-body.ts) |
| Blender/bpy (upstream UniRig tooling) | conversions inside sidecar only                    | GPL                                                                                    | isolated subprocess; adapters return neutral npz/json; never shipped                                                                                                                                                  |

Blender **4.5.15 LTS Windows x64 portable** is also available as an explicit optional external-tool
download, separately from UniRig's retained bpy environment. The official mirror archive/executable
SHA-256 pins, exact sizes and source URL live in
[`tools.json`](../../packages/registry/catalog/tools.json). GPL-3.0-or-later; preserve the full
upstream distribution notices and corresponding-source access. Integration scripts must remain
GPL-compatible. No Blender binary/environment is app-bundled, and a subprocess is not itself a
license exception. Native operator checks pass; real garment corrections remain rejected. See the
[trial](../../future/maintained-blender-trial.md) and [tool lifecycle](../user/extensions.md).

### Frozen UniRig Windows environment

[Recipe](../../sidecar/runtimes/unirig-win.json) and [lock](../../sidecar/runtimes/unirig/uv.lock)
pin an external, wheels-only environment. No third-party model source, Python environment or CUDA
wheel is app-bundled.

| Components                                                                                   | Role/terms                                                              | Delivery and evidence                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Torch 2.7+cu128, torchvision 0.22                                                            | BSD-3 plus bundled CUDA runtime notices                                 | Exact official wheel/index hashes in lock; separate from TRELLIS.2 Torch 2.8                                                                                                             |
| flash-attn 2.8.3, PyG scatter/cluster                                                        | BSD-3 / MIT                                                             | Exact cp311/Torch 2.7/CUDA 12.8 community/official PyG wheels; all bytes pinned. PTv3 varlen remains disabled.                                                                           |
| spconv-cu124 2.3.8, cumm-cu124 0.7.11                                                        | MIT sparse CUDA kernels                                                 | PyPI prebuilt Windows wheels; native admission checks exercise finite outputs                                                                                                            |
| Triton Windows 3.3.1.post21                                                                  | MIT core with bundled toolchain notices                                 | External matched Torch 2.7 runtime; retain its included notices; no user MSVC/CUDA-toolkit installation                                                                                  |
| UniRig/Michelangelo/bpy 4.2.0                                                                | MIT weights/root source; GPL Michelangelo/bpy components                | User-downloaded source and isolated subprocesses; retain source notices. Neutral rig JSON/NPZ boundary remains.                                                                          |
| pyrender 0.1.45 / PyOpenGL 3.1.0                                                             | MIT / BSD and historical OpenGL component notices                       | PyOpenGL universal piwheels wheel: all 2131 Python files match official sdist, no DLL/native payload; setup preserves the complete 11,117-byte source notice. Native pyrender exercised. |
| Lightning 2.5.1, transformers 4.51.3, open3d 0.19, trimesh 4.6.8, fast-simplification 0.1.11 | Apache-2.0 / MIT                                                        | Frozen prebuilt wheels. Unused OmegaConf/wandb omitted; selected simplifier permits NumPy 1.26.4.                                                                                        |
| Owned OPT architecture description                                                           | MIT fairseq/UniRig architecture facts plus Apache Transformers defaults | [Provenance and notice](../../sidecar/notices/unirig-opt-architecture.md); all active settings match. No Meta OPT config, weights or tokenizer in the new version.                       |

The original catalog's Meta OPT config carried noncommercial/production restrictions.
`36842e2b.local1` omits that download, retains the two identical verified UniRig checkpoints and
uses the packaged owned architecture description. Existing historical files/receipts are preserved;
the adapter always selects the owned configuration.

Fresh-profile installed setup and real checkpoint inference pass on Windows x64/RTX 3090, including
normalized skin weights and animated sprite exports. The
[F4 receipt](../../future/qualification/model-workflow-windows-x64.json) retains the sample's
rig/retarget advisories; it does not certify a new model default, additional hardware or a public
release.

## Animation

| Dependency                                                       | Role                                                                            | License              | Status                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quaternius Universal Animation Library — selected free clips** | bundled `ual` pack (86 clips incl. **8-direction locomotion with root motion**) | CC0                  | **✓** · one universal humanoid rig = one retarget profile; bundled subset declared in `packages/anim/packs/ual/pack.json`; personal imports remain separate |
| Mesh2Motion assets                                               | alternate + creature clips (Track B future); app = reference implementation     | art CC0, code MIT    | **✓** explicitly free for personal/commercial                                                                                                               |
| Retargeter                                                       | humanoid profile retarget, once, in core                                        | ours (TS)            | three SkeletonUtils (MIT) as reference only                                                                                                                 |
| Test-pose pack                                                   | rig deform checks                                                               | CC0-derived from UAL | bundled asset                                                                                                                                               |

**Traps (do not use):** Mixamo — usable in projects, **not redistributable** (personal user-import
only). AMASS / SMPL-family — research-only. Ubisoft LAFAN1 — non-commercial research. Bandai Namco
motion datasets — CC-BY-NC. CMU mocap — genuinely free for any use, optional later import path, not
the bundled starter.

## Repair research only

These components were evaluated outside the application and are not new catalog integrations or
bundled dependencies. Their negative quality results do not justify increasing the base payload.

| Component                                     | Terms and pin                                                                                                                                       | Evaluation boundary                                                                                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mesh2Motion TypeScript weight solver          | Project states MIT; source `653a9698f5f315523072f1c3ff3496100401317b`                                                                               | Required source graph only, using existing Three.js; rejected as an automatic replacement. [Results](../../future/cpu-deformation-evaluation.md)                                                                                             |
| TokenRig / SkinTokens                         | Root MIT and MIT-declared checkpoints; Michelangelo encoder provenance includes GPL                                                                 | Source `273b691d35989d71cd17ff2895fdc735097b92d1`, model `79736cad0fd84de384d5eede659b4ebd24effe33`; isolated worker, not bundled. Quality and clean provisioning remain open. [Audit and measurements](../../future/tokenrig-evaluation.md) |
| TokenRig disposable overlay                   | Apache-declared Transformers 4.57.1, Diffusers 0.35.1, Hugging Face Hub 0.35.3 and Tokenizers 0.22.1; BSD-declared OmegaConf 2.4.0 and psutil 7.1.0 | Research environment only, reusing existing Torch read-only. Retained package metadata is not a complete redistribution/transitive audit. [Provenance](../../future/tokenrig-evaluation.md#provenance-and-deployment-boundary)               |
| CPU XPBD-style cloth / Blender Surface Deform | Experimental NumPy code; existing external GPL `bpy` 4.2                                                                                            | No new physics library or Blender installation; candidates rejected on final-surface quality. [Results](../../future/cloth-evaluation.md)                                                                                                    |

## GUI

| Dependency                                                | Role                                                                                                                                                    | License     | Status                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| React 19 + Vite                                           | framework + build                                                                                                                                       | MIT         | std                                                                                                |
| **Base UI** `@base-ui/react`                              | headless interaction and accessibility primitives                                                                                                       | MIT         | 1.6.0; native accessibility qualification remains F7 work                                          |
| three.js (pinned) + camera-controls + TransformControls   | inspection viewports — in use since P4-T2: three 0.185.1, camera-controls 3.1.2, @types/three 0.185.2, all EXACT-pinned (three moves addon APIs freely) | MIT         | std                                                                                                |
| Lingui                                                    | ICU i18n, literal English IDs, Spanish/pseudo catalogs and extraction gate                                                                              | MIT         | 6.6.0; `npm run i18n:extract -w spritebook-studio`                                                 |
| Barlow Condensed, Geist Mono                              | Studio Imprint display and UI type                                                                                                                      | SIL OFL 1.1 | Bundled WOFF2, source hashes and complete OFL notices in `apps/studio/public/fonts/`               |
| Chakra Petch, IBM Plex Sans/Mono, Silkscreen, EB Garamond | Historical identity studies only; not app-bundled                                                                                                       | SIL OFL 1.1 | Retained sources/notices in `future/ui-concepts/`; not OS-installed                                |
| axe-core (dev only)                                       | a11y audit against the dev app (never bundled)                                                                                                          | MPL-2.0     | std; devDependency only — MPL is file-level copyleft, acceptable for a dev tool that ships nothing |

## Remaining gates and historical decisions

1. F7 distribution clearance: complete native/static dependency notices, runtime prerequisites and
   the recorded `pako` Zlib allowlist mismatch remain open. Windows functional qualification does
   not close these distribution gates.
2. New model/weight recipes need their own complete component and agreement review. U²-Net's current
   Apache-2.0 weight is catalog-pinned; that review does not extend to other rembg weights.
3. Make-It-Animatable was not cleanly verified (D-026); it is not a current model integration.

Tauri v2 remains the selected desktop shell (D-005/D-041); TypeScript on Node is the current core.
The runtime migration adds no alternative shell or core-language port.
