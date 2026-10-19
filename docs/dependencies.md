# SpriteBook — dependencies (bill of materials)

**Rule: check this file before adding any dependency; new deps get a row here in the same PR.**
Status marks: **✓** license verified during the 2026-07 design cycle · **std** well-established,
re-confirm at pin time · **⚠** gate open — verify before integration.

**License posture:** everything _bundled_ is MIT / Apache-2.0 / BSD / ISC / OFL / CC0. AI model
weights are never bundled — catalog entries installed on demand behind license/territory/VRAM gates.
No third-party copyleft in the shipped binary path (GPL tooling allowed only as isolated sidecar
subprocesses). **SpriteBook's own license is AGPL-3.0-only with an output exception + attribution
request (D-019)** — permissive deps combine into an AGPL work cleanly, so the bundling rules above
are unchanged.

## Runtime & shell

| Dependency               | Role                                                                                                                                                                                                          | License             | Status           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------- |
| Deno 2.x                 | TS runtime, workspace, WebGPU, tests                                                                                                                                                                          | MIT                 | std              |
| zod 4.x                  | runtime validation for `@spritebook/schema`; v4 core rewrite + native JSON-Schema interop (pairs with D-009 `paramsSchema`)                                                                                   | MIT                 | std; lock-pinned |
| Tauri 2.x (pin minor)    | app shell — **chosen by P0-T3 (D-005)**; `deno desktop` revisit trigger noted in D-005; in use since P4-T1 (`apps/studio/src-tauri`, pinned 2.11/2.6 + serde, serde_json, base64 crates — all MIT+Apache-2.0) | MIT+Apache-2.0      | std              |
| wgpu (under Deno WebGPU) | GPU backend                                                                                                                                                                                                   | MIT/Apache-2.0 dual | std              |

The shell also directly uses lock-pinned `windows-sys` 0.61.2 (MIT/Apache-2.0) for Windows job
objects and `libc` 0.2 (MIT/Apache-2.0) for Unix process groups. Both already belonged to the Tauri
dependency graph; F1-T3 uses them to cancel owned CLI descendants and clean up on close.

F2's isolated renderer experiment (`tools/qualification`, not the production runtime) pins `webgpu`
**0.6.2**. Its npm metadata says MIT, but its actual `LICENSE.md` is **BSD-3-Clause** (Dawn/Tint);
retain the shipped text. The addon is evaluated with an app-owned **Node 24.22.0** (MIT plus Node's
bundled third-party notices). Build-only npm transitives are `debug` (MIT), `ms` (MIT) and
`@webgpu/types` (BSD-3-Clause); the deployed loader imports none of them. Windows shader DLLs and
native transitive notices require an explicit artifact audit before a shipping claim; do not copy
the entire npm distribution on the strength of its metadata label.

The Windows Vulkan proof bundles the **LunarG Vulkan Runtime 1.4.341.0** x64 loader (MIT/Apache-2.0,
with its complete `VulkanRT-License.txt`). Its official Components archive is SHA-256 pinned in the
proof builder. Dawn needs this loader beside the addon: its current Windows search path fails to
load the system copy by basename. The Vulkan payload excludes FXC, DXC and their DLLs; Direct3D 12
experiments with DXC are separate from that artifact. PE imports also require the Microsoft VC++
runtime on the machine; it is not silently copied from Visual Studio.

## Core render, style, pack

| Dependency        | Role                                                            | License     | Status       |
| ----------------- | --------------------------------------------------------------- | ----------- | ------------ |
| WGSL shader stack | NPR passes                                                      | ours        | —            |
| fast-png          | PNG encode/decode                                               | MIT         | std          |
| pixelmatch        | golden diffs                                                    | ISC         | std          |
| OKLab math        | perceptual quantize                                             | ours (tiny) | implement    |
| maxrects-packer   | atlasing                                                        | MIT         | std          |
| gifenc            | contact-sheet artifacts only (player is interactive, never GIF) | MIT         | std          |
| Mesa lavapipe     | CI software Vulkan                                              | MIT         | std, CI-only |

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

| Dependency             | Role                        | License                                                     | Status                                                                                                                                                              |
| ---------------------- | --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python 3.11+ / PyTorch | runtime                     | PSF / BSD-3                                                 | std                                                                                                                                                                 |
| rembg                  | background removal          | MIT                                                         | std; **per-weight**: u2net.onnx **✓ verified Apache-2.0** (2026-07-19, catalog entry `rembg-u2net`, hash-pinned); verify every future weight as it becomes an entry |
| onnxruntime (CPU)      | rembg inference             | MIT                                                         | std; sidecar env only (uv-managed), CPU build — no CUDA requirement for imageprep                                                                                   |
| ajv (npm, core-side)   | paramsSchema validation     | MIT                                                         | std; exact-pinned; validates adapter JSON Schemas in core BEFORE jobs reach the sidecar (D-009)                                                                     |
| Pose check v1          | A-pose advisory             | ours (silhouette heuristic on rembg alpha — **no new dep**) | audit item 14                                                                                                                                                       |
| MediaPipe Pose         | optional pose-check upgrade | Apache-2.0                                                  | later, catalog-installed extra                                                                                                                                      |

## Generation backends (catalog — installed on demand)

**Surveyed against four gates 2026-08-06 (D-036); transcript in
[`docs/internal/proofs/backends.md`](internal/proofs/backends.md). The ✓ marks below were
planning-era and described MODELS; the rows now describe STACKS, which is what ships.**

| Backend          | License (model)           | Status                                                                                                                                                             |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **TRELLIS.2 4B** | MIT (weights)             | **⚠ shipping, stack encumbered** — see the CUDA-extension rows below. Measured **3.01 GiB** at shipped defaults, 16.53 GiB at `lowVram=false`                      |
| Pixal3D          | MIT                       | ✗ **not viable**: requires the TRELLIS.2 base env (inherits everything below) **and** compiles NATTEN from source — wheels-only gate                               |
| TripoSplat       | MIT                       | ✗ **not applicable**: emits gaussians, not a mesh (invariant 4)                                                                                                    |
| Hunyuan3D 2.x    | Tencent Community License | ✗ **excludes EU/UK/KR** — territory carve-out; only ever a user-installed gated extra, never a default                                                             |
| TripoSG          | MIT (repo only)           | ✗ `NOTICE` discloses HunyuanDiT + FlashVDM (Tencent community licences) and BRIA RMBG-1.4; shape-only                                                              |
| Step1X-3D        | Apache-2.0                | ✗ source builds (`custom_rasterizer`, `differentiable_renderer`, PyTorch3D-from-git); Linux-only. **Best-licensed candidate — revisit if it ships Windows wheels** |
| Direct3D-S2      | MIT                       | ✗ `torchsparse` builds from source; shape-only                                                                                                                     |
| `fixture-gen`    | MIT (ours)                | ✓ weightless, CPU, all platforms — the reason macOS/win-arm64 degrade rather than break                                                                            |

### TRELLIS.2 CUDA extension wheels (the runtime stack)

Not bundled — `spikes/trellis2/wheels/*.whl` is gitignored, only the sha256 pins are committed and
the user's machine fetches them, as with model weights. Licences below were read from each installed
`dist-info/`, not from a project page.

| Wheel                    | License                                                                                                           | Status                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `nvdiffrast` 0.4.0       | **Nvidia Source Code License (1-Way Commercial)** — §3.3 non-commercial, _"research or evaluation purposes only"_ | **⚠ blocks commercial use.** On the happy path: `o_voxel.postprocess.to_glb` calls `dr.rasterize`/`dr.interpolate` for the texture bake |
| `nvdiffrec_render` 0.0.0 | **NVIDIA Source Code License for nvdiffrec** — §3.3 same non-commercial limitation                                | **⚠ blocks commercial use**                                                                                                             |
| `o_voxel` 0.0.1          | **none declared** (no LICENSE, no classifier) — defaults to all rights reserved                                   | **⚠ unlicensed**; the module our adapter imports directly                                                                               |
| `cumesh` 1.0             | MIT                                                                                                               | ✓                                                                                                                                       |
| `flex_gemm` 0.0.1        | MIT                                                                                                               | ✓                                                                                                                                       |
| `utils3d`                | pinned to a git commit (no PyPI release)                                                                          | imports `nvdiffrast` in `torch/rasterization.py`                                                                                        |

**Trap:** an MIT badge on a generative-3D repo describes the model, not the stack. Every candidate
surveyed reaches NVIDIA's non-commercial rasterizer, because `nvdiffrast` is the differentiable
rasterizer this whole field is built on. Check `NOTICE` and the installed `dist-info/`, not the
README.

## Rigging

| Dependency                            | Role                                                                 | License                                                          | Status                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UniRig** (code + weights)           | Track B generic auto-rig                                             | MIT                                                              | **✓** both GitHub LICENSE and HF model card; staged checkpoints → registry pins exact hashes                                                                                                                          |
| Make-It-Animatable                    | Track A humanoid accelerator (<1 s; meshes & splats; arbitrary pose) | **⚠ unverified**                                                 | Confirm repo LICENSE before p3 integration; training pulls Mixamo data. Fallbacks: UniRig humanoid, canonical-body fit                                                                                                |
| Canonical Track A body                | roster-fit rig                                                       | ours, seeded from CC0 **Universal Base Characters** (Quaternius) | **✓ CC0 re-verified 2026-07-20** from the downloaded pack's License_Standard.txt; both bodies bundled at `packages/rig/bodies/` (65-joint UAL skeleton, full core, byte-stable builds via tools/roster/build-body.ts) |
| Blender/bpy (upstream UniRig tooling) | conversions inside sidecar only                                      | GPL                                                              | isolated subprocess; adapters return neutral npz/json; never shipped                                                                                                                                                  |

## Animation

| Dependency                                                  | Role                                                                                    | License              | Status                                                                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quaternius Universal Animation Library 1+2 — free tiers** | bundled starter pack (~120–130 clips incl. **8-direction locomotion with root motion**) | CC0                  | **✓** · one universal humanoid rig = one retarget profile; glTF exports available. Bundle free tiers only; paid Source packs = one-click user import |
| Mesh2Motion assets                                          | alternate + creature clips (Track B future); app = reference implementation             | art CC0, code MIT    | **✓** explicitly free for personal/commercial                                                                                                        |
| Retargeter                                                  | humanoid profile retarget, once, in core                                                | ours (TS)            | three SkeletonUtils (MIT) as reference only                                                                                                          |
| Test-pose pack                                              | rig deform checks                                                                       | CC0-derived from UAL | bundled asset                                                                                                                                        |

**Traps (do not use):** Mixamo — usable in projects, **not redistributable** (personal user-import
only). AMASS / SMPL-family — research-only. Ubisoft LAFAN1 — non-commercial research. Bandai Namco
motion datasets — CC-BY-NC. CMU mocap — genuinely free for any use, optional later import path, not
the bundled starter.

## GUI

| Dependency                                              | Role                                                                                                                                                    | License     | Status                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| React 19 + Vite                                         | framework + build                                                                                                                                       | MIT         | std                                                                                                |
| **Base UI** `@base-ui/react`                            | headless a11y primitives (35 comps incl. number-field scrubbing)                                                                                        | MIT         | **✓** v1.0 stable Dec 2025; full-time MUI team incl. Radix authors; WCAG out of the box            |
| three.js (pinned) + camera-controls + TransformControls | inspection viewports — in use since P4-T2: three 0.185.1, camera-controls 3.1.2, @types/three 0.185.2, all EXACT-pinned (three moves addon APIs freely) | MIT         | std                                                                                                |
| Lingui                                                  | ICU i18n — runtime wired P4-T1, pinned 6.6.0; extraction pass later                                                                                     | MIT         | std                                                                                                |
| zustand                                                 | GUI-local state                                                                                                                                         | MIT         | std                                                                                                |
| Chakra Petch, IBM Plex Sans/Mono                        | type                                                                                                                                                    | SIL OFL 1.1 | std                                                                                                |
| axe-core (dev only)                                     | a11y audit against the dev app (never bundled)                                                                                                          | MPL-2.0     | std; devDependency only — MPL is file-level copyleft, acceptable for a dev tool that ships nothing |
| Lucide                                                  | icons                                                                                                                                                   | ISC         | std                                                                                                |

## Open gates

1. ~~Make-It-Animatable license~~ — resolved 2026-07-18 (D-026): NOT cleanly verified; Track A ships
   on fit + UniRig-humanoid.
2. rembg per-weight licenses — u2net **✓ closed 2026-07-19** (Apache-2.0, catalog-pinned); re-opens
   per additional weight.

Resolved 2026-07-11: ~~deno desktop vs Tauri~~ → **Tauri v2** by P0-T3 (D-005; `deno desktop`
revisit trigger recorded there).
