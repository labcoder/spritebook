# Replacing Deno without losing the renderer

Research snapshot: **2026-10-18**. The maintainer has confirmed Tauri, a TypeScript core/CLI, and
replacing Deno, and approved [migration in this repository](migration-strategy.md). That reviewed
baseline ran Deno; main now uses Node through the [F4 cutover](runtime-cutover.md). The
[F2 experiment](renderer-qualification.md) adds isolated runtime pins and measured Windows renderer
evidence. The [finalized roadmap](roadmap.md) targets supported Node LTS and qualifies Node/Dawn
first; shipping adoption is gated by the evidence below.
[Technology decisions](technology-options.md) records the settled scope and historical alternatives.

## The deadline and the actual dependency

Deno's announcement separates runtime and hosting: the runtime receives monthly bug/security
releases for another year after **2026-10-09**, while Deploy has a six-month shutdown horizon. JSR
continues operating, and rusty_v8 remains supported. SpriteBook is a local application; its problem
is the runtime's maintenance horizon, not migrating a Deploy service to Workers. An open-source
continuation is possible, not a support commitment we should assume.
[Deno announcement](https://deno.com/blog/cloudflare).

Use **2027-06-30 as a proposed internal Deno-free release target**, leaving time for migration and
rollback before approximately October 2027. This is our planning buffer, not an upstream deadline or
delivery estimate. If the work slips, reduce UI/model scope before extending dependence on an
unmaintained GPU runtime.

Deno owns five distinct things here: TypeScript execution/module resolution, OS/process APIs,
headless WebGPU, tests/tooling, and executable packaging. Replacing only the task runner or
switching `deno` to `node` leaves most of the problem untouched. A scoped lexical scan of non-test
`packages/*.ts` found Deno references in **61 production-source files** (comments/types included);
it is a coupling indicator, not an AST call count or port estimate. Configuration and helpers add
more surface. This describes the reviewed Deno baseline; F4 retired `deno.json` in favor of the
[current Node workspace](../package.json).

## Recommended architecture choice

**Recommend Node LTS for the confirmed TypeScript core, with Node/Dawn qualified first.** This
retains glTF-Transform, the retargeter, style math, packer, exporters, and schema validation while
removing their dependence on Deno APIs. Keep Python/native inference behind the existing process
contract and keep the desktop independent of the chosen CLI language.

Start with the existing renderer on Node/Dawn. Use the Deno implementation as a reference; a Rust
worker is a scoped contingency if the first path fails, not a parallel core rewrite:

| Candidate                        | Why it could win                                                                                                                                        | What must be proved                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node + Dawn `webgpu` binding** | Least shader/host-code churn: retain the JS WebGPU API and most existing renderer code                                                                  | Native addon/assets package on every required target; full AOV/readback behavior, lifetime/cancellation, driver diagnostics, old/new quality and performance        |
| **Rust `wgpu` render worker**    | Removes the JS binding from the GPU component; follows Deno's existing underlying graphics family; natural standalone worker and future native-UI reuse | Port of host setup/upload/skinning/attachments, compatible canonical inputs, packaged shader/assets, all-platform renderer tests, process overhead and cancellation |

**Choose Node/Dawn if it passes the rendering, platform and installed-package gates.** This retains
the TypeScript GPU host code and avoids an unnecessary native port. Only investigate Rust/wgpu if a
specific support, correctness, packaging or maintainability failure justifies it, and obtain a
separate decision before adopting that native component. It must not absorb schema, manifest,
animation, style, pack or export policy. Do not maintain two production renderers. A full Rust core
or GPUI editor is outside the selected scope.

The `webgpu` package provides offscreen textures/compute/readback, which matches this application;
its lack of canvas/DOM integration is not a blocker. Its main build workflow currently targets
Windows x64/ARM64, Linux x64/ARM64 and universal macOS. A CI target is evidence of build intent, not
our successful shipped binary test. Dawn's own Node README still describes the bindings as work in
progress. [Binding](https://github.com/dawn-gpu/node-webgpu),
[build matrix](https://github.com/dawn-gpu/node-webgpu/blob/main/.github/workflows/build.yml),
[Dawn Node status](https://dawn.googlesource.com/dawn/+/HEAD/src/dawn/node/README.md).

Native wgpu supports Vulkan, Metal, and DX12 and accepts WGSL through its shader stack. Its API is
not a line-for-line JS port. It also exposes `driver`/`driver_info`; collect available values
without assuming every platform supplies an equally useful driver version.
[wgpu](https://github.com/gfx-rs/wgpu),
[AdapterInfo](https://docs.rs/wgpu/latest/wgpu/struct.AdapterInfo.html).

## Other routes and their current status

The desktop and core-language choices are settled. These entries preserve the earlier comparison;
they do not introduce alternate implementation tracks into the migration roadmap.

| Route                              | Assessment                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Full Rust core + Tauri/React**   | Not selected. The maintainer is retaining TypeScript for product behavior and the core                                                                                                                                                                                                                                       |
| **Full Rust core + GPUI Kit**      | Not selected. Both the core-language replacement and desktop-toolkit replacement are outside scope                                                                                                                                                                                                                           |
| **Bun**                            | Supports standalone JS/TS executables, so it is a real packaging candidate. A standalone compiler does not prove our headless GPU/native-module stack. Prefer Node's supported-release policy unless a measured Bun advantage pays for another runtime decision. [Bun executables](https://bun.com/docs/bundler/executables) |
| **Browser/Chromium render worker** | Can reuse WebGPU code, but adds browser launch, graphics flags, process/packaging behavior and version control to headless CLI operation. Reserve for a measured failure of native routes, not the default batch architecture                                                                                                |
| **Python core/CLI**                | Useful inference ecosystem, but moves already-proven TS schema/animation/style/export behavior and does not solve GPU runtime or packaging by itself. Keep Python at the model boundary                                                                                                                                      |
| **Deno fork / frozen Deno**        | Keep the pinned build as migration control and legacy reader. Not the default new product: security and graphics fixes become our responsibility once upstream support ends                                                                                                                                                  |
| **Cloudflare Workers/workerd**     | The announcement concerns server infrastructure. It is not a replacement for local filesystem editing, arbitrary model subprocesses and this desktop GPU workload                                                                                                                                                            |

Node 24 is the current LTS in the reviewed release table; Node 26 is still Current on this research
date. Pin a supported LTS at implementation and revisit as its lifecycle changes; do not claim that
current v26 API documentation automatically describes v24 packaging.
[Node release policy/table](https://nodejs.org/en/about/previous-releases).

## Port surface and order

| Current surface                                                   | Replacement work                                                                                                           | Important compatibility check                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `deno.json` workspaces/import maps; `npm:` and `jsr:` imports     | npm workspaces/package exports, exact dependency lock; compile shipped JS                                                  | Preserve module boundaries; eliminate runtime network module resolution; do not update dependency versions as a side effect |
| `Deno.read/write*`, `stat`, `readDir`, `rename`, `remove`, errors | Node `fs`/`fs/promises`, URL/path helpers, explicit error-code handling; Rust equivalents only in chosen native components | Windows path/rename behavior, atomicity/locking, non-ASCII paths, file modes, symlinks, cleanup                             |
| `Deno.Command`, PID, signals, env/build/args                      | Node child process APIs or Rust process APIs                                                                               | Streaming without deadlocks, token secrecy, stdout/stderr separation, process-tree cancellation, status/exit codes          |
| `navigator.gpu`, WebGPU constants, `DENO_WEBGPU_BACKEND`          | Explicit selected GPU implementation and backend selector                                                                  | Missing-adapter handling, limits/features, 256-byte readback rows, loss/error scopes, shader/resource lifetime              |
| `Deno.test`, std asserts, permissions and sanitizer behavior      | One chosen JS test runner (prefer built-in `node:test` if sufficient); Rust renderer tests where applicable                | Carry fixtures and assertions across; do not lose resource-leak/skip rules or confuse missing GPU with pass                 |
| `deno fmt/lint/check/task`, hooks and CI helpers                  | One consistent formatter/linter, `tsc --noEmit`, cross-platform scripts, native CI                                         | Node type stripping is not type checking; tasks must work in PowerShell as well as POSIX shells                             |
| `deno compile` and lean release tree                              | Bundled app-owned runtime + compiled JS/assets/native libraries, or a tested executable packaging path                     | No system runtime or checkout required; importer and model/codecs work from installed layout                                |
| Tauri `run_cli` invoking source                                   | Locate the bundled CLI/runtime by app resource path                                                                        | Exact binary chosen, scoped invocation, same command semantics, clean-machine and upgraded install tests                    |

Do not scatter a permanent `Deno` compatibility shim across the project. Port filesystem/process
calls directly where simple; use narrow shared helpers for real shared policy such as transactions,
artifact access and subprocess ownership. Reuse existing canonical schemas and the file-based render
seam. [Render entry](../packages/render/mod.ts), [bake](../packages/pack/bake.ts).

Node can strip erasable TypeScript syntax, but does not type-check it or implement tsconfig path
mapping/TSX. Build shipped JavaScript and keep a separate type-check gate; parameter properties in
existing classes also make a blind direct-run change unsafe.
[Node 24 TypeScript support](https://nodejs.org/docs/latest-v24.x/api/typescript.html).

Single-executable packaging remains a separate spike: Node's SEA facility exists, with its own
native-addon/assets and signing rules. A runtime directory bundled with the app is an acceptable
first complete release if executable packaging introduces avoidable risk. Test the selected LTS
rather than adopting features documented only in Current.
[SEA documentation](https://nodejs.org/api/single-executable-applications.html).

## Renderer trial: one representative workload

Use the committed asymmetric fixture plus one rigged character with an attachment, alpha-mask
material, representative clip and each style preset. Include width **100 px** to exercise padded
readback; include non-square cells, 1×/2×/4× sampling, multiple directions, and all five AOVs. Use
current Deno output as the reference implementation and collect new platform results.

Pass gates:

1. Exact dimensions, sampling count, pivot/scale, palette membership, AOV rect alignment and
   mirroring rules; existing numeric retarget/pose checks still pass.
2. Same-runtime same-machine double renders are byte-identical. Compare different implementations
   with reviewed image diffs/tolerances; same hardware alone does not require old/new bytes equal.
3. Cold/warm wall time, peak RSS, GPU memory, throughput, adapter/driver and failure counts reported
   for Windows DX12/Vulkan, Apple Silicon Metal and Linux Vulkan/lavapipe. A starter target is no
   more than 10% end-to-end regression against the same workload; exceptions need explicit approval.
   The maintainer narrowed F2 to Windows x64; the other native targets move to F7 release
   qualification. Record a private DX12 experiment separately from the packaged Vulkan candidate.
4. Device loss and mid-job cancellation produce honest terminal results and never publish a partial
   bake. Missing hardware is reported as unverified, not a passing platform.
5. Packaged execution works without a source checkout or development toolchain. Inspect every
   binary's notices/transitives under the [existing dependency policy](../docs/dependencies.md).

Timebox the Node/Dawn qualification to a representative slice, not a duplicate application. If it
fails, record the specific condition and evaluate the native-worker contingency only where it can
resolve that condition. If no renderer passes, keep production cutover blocked at the renderer gate;
do not reopen the confirmed Tauri/TypeScript choices as an automatic workaround. The
[roadmap](roadmap.md) defines the task order and separates this gate from later feature work.

## Contract and data migration

Freeze examples of current manifests, journals, catalog/receipts, NDJSON, poses, canonical GLBs,
BakeManifests and engine exports. Verify accepted and rejected inputs across old/new binaries.
Correct known data-safety defects first, especially artifact undo; they are not behavior to preserve
as compatibility. [Architecture findings](architecture-review.md).

Keep immutable character IDs and existing exported outputs. Validate upgrades on a **copy** before
changing the active workspace; retain original workspace/assets/journal for rollback. A new binary
must refuse unsupported future schemas clearly. Old readers may be unable to read new schemas, so
rollback means opening the preserved pre-upgrade copy, not pointing an old app at mutated data.

Every renderer replacement gets a new `rendererVersion`/signature and cache namespace. Do not erase
old cache or bakes to make the new code pass, and do not treat an old cache hit as proof of new
renderer correctness. Shader/build/backend/adapter and available driver identity belong in the
signature/provenance; output pixels never become cache keys.

Exit only when a clean install can perform **mesh → animated sprite sheet → real engine import**,
CLI and GUI agree on current state, old workspace conversion/rollback are proven, and CI/release
commands no longer execute Deno. Archive the last supported Deno build as a migration tool; shipping
new features on it indefinitely is a separate support decision.
