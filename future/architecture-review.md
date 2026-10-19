# Architecture review and proposed boundaries

Reviewed **2026-10-18**, SpriteBook commit `42be3bbebfc783edb42fb64001aa9b2e3d638c98`. This is a
source review plus one focused CPU-only reproduction, not a fresh full-suite or GPU audit.
References to measured performance below identify historical evidence explicitly.

**Decision update:** the maintainer has selected Tauri and the TypeScript core/CLI, with Deno to be
replaced, and has approved [incremental migration in this repository](migration-strategy.md). Full
Rust core and alternate desktop shells are outside scope. The [migration roadmap](roadmap.md) now
defines the execution order; the source findings below remain the current implementation baseline.

## Verdict

**Keep the product contracts and most algorithms; replace the runtime dependency and repair the
ownership seams.** The package separation is valuable. The weakest parts are consistency across
files/processes, clean-machine delivery, and whether installed models are actually runnable.
Changing language alone does not repair them.

The previous [August audit](../docs/internal/proofs/adversarial-audit-2026-08-16.md) is unusually
useful, but its overall statement that all laws hold needs qualification. Some contracts are
implemented, some are incomplete, and reversible manifest data does not yet imply reversible assets.
The audit's key findings below remain visible in this checkout.

## What runs today

The [declared architecture](../docs/architecture/architecture.md) describes three process roles:
Deno/TypeScript core, Python AI sidecar, and Tauri/React desktop. In actual execution, the desktop
launches a **new CLI process per action**, using ambient `deno run -A` against a checkout path. The
CLI pumps job executors directly; `JobQueue` has no production instantiation. Cross-process GPU
admission instead uses filesystem VRAM leases. The diagram's central queue is therefore not the
production scheduler. [Shell bridge](../apps/studio/src-tauri/src/main.rs),
[CLI](../packages/cli/mod.ts), [queue](../packages/core/queue.ts),
[VRAM lease](../packages/core/vramlease.ts).

| Area                  | Keep                                                                                                    | Change or investigate                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema and identity   | Validation on read, immutable IDs, canonical JSON, versioned persisted documents                        | Treat `packages/schema` as authoritative: CharacterManifest is v3; Project/BakeManifest/AnimPack remain v2. The readable architecture reference is partly historical. Export language-neutral contracts before porting |
| CLI                   | Shared GUI arg builders, strict unknown-flag refusal, actionable errors, JSON events                    | Declare flag arity/help once; reject missing/duplicate values; normalize workspace/pack flags with compatibility aliases; distinguish query documents from job streams                                                 |
| Manifest/history      | Precomputed inverse patches, core-owned changes                                                         | One writer path for commit/undo/redo with lock, crash recovery, unique temp files, and asset restoration; see safety findings                                                                                          |
| Importer              | Canonical uncompressed glTF, units/facing/grounding, skin preservation, double-import tests             | Preserve parser and conversion behavior through migration. Interim FBXLoader is actually implemented; ufbx is a target, not a current feature. Test parser/texture/native assets from release artifacts                |
| Animation and rigging | Core retarget-once, preview GLBs, two rig tracks, semantic aliases, numeric deformation checks          | Preserve root motion/contact behavior and asymmetric bodies; backend hardware floors are config-specific. A good mesh generator is not a replacement for rigging                                                       |
| Rendering             | Headless MRT AOVs, WGSL, padding-correct readback, world-locked scale                                   | Replace Deno's GPU host; keep structural and perceptual evidence. Do not rebuild output truth independently in the GUI                                                                                                 |
| NPR style             | OKLab, character-wide palette, ordered dither, hysteresis, stable lighting and grid                     | Profile before porting/parallelizing; preserve frame order within temporal chains and palette scope across clips                                                                                                       |
| Pack and export       | One deterministic atlas layout replayed for all passes; pure BakeManifest projections; per-clip timing  | Keep byte-stable outputs and engine smoke tests. No engine-specific renderer or layout fork                                                                                                                            |
| Cache                 | Hash actual input assets/clip content; character ID, recipe, and renderer signature                     | Renderer changes get a new namespace; capture backend/build/driver where available. Current adapter hash does not detect driver-only changes                                                                           |
| Registry              | Catalog → verified installation → project pins; staged hash-checked downloads; params-driven forms      | Enforce pins in production, rerun license/territory gates at execution, include all transitive assets and actual runtime compatibility                                                                                 |
| Sidecar               | Version handshake, loopback binding, per-session token, validated NDJSON, terminal-event checks         | Isolate backend environments, reuse loaded models across suitable jobs, manage cancellation/process trees, account for retained VRAM                                                                                   |
| Studio                | Six stages, CLI twins, pixel-truth player, raw logs, token themes, localization, accessible async focus | Scope state to character, expose core read queries, restore current bake consistently, keyboard joint nudge, visible cancellation                                                                                      |
| Delivery and CI       | Three-OS tests, required lavapipe GPU lane, target binary smokes, engine checks                         | Deliver the complete app without a repo/system Deno; test platform-native installers, optional inference profiles, signing and update recovery                                                                         |

Evidence: [schema migration](../packages/schema/migrate.ts),
[importer](../packages/importer/import.ts), [FBX bridge](../packages/importer/fbx.ts),
[retargeter](../packages/anim/retarget.ts), [bake](../packages/pack/bake.ts),
[render](../packages/render/renderer.ts), [style](../packages/style/mod.ts),
[packer contracts](../packages/pack/contracts.ts), [exporters](../packages/export/mod.ts),
[diagnostics](../packages/render/diagnostics.ts), [registry](../packages/registry/install.ts),
[sidecar schema](../packages/schema/sidecar.ts), [CI](../.github/workflows/ci.yml).

## Safety work before migration

### A1 — Asset undo restores metadata without restoring the mesh: reproduced

A temporary workspace used two valid GLBs: the committed asymmetric fixture and a copy with a red
material. Both were recorded as generation results, then passed through the real exported `runCli`:
**pick r1 → pick r2 → undo**. On Deno 2.9.2, undo returned 0 and restored the selected result and
manifest mesh hash to r1. The bytes at `canonical/model.glb` still hashed to r2. No GPU, model
download, or real workspace was involved; the scratch directory was removed.

```text
undo exit:                0
manifest picked result:   r1
manifest mesh hash:       hash(r1)
canonical/model.glb:      hash(r2)
bytes match manifest:     false
```

This is not a hypothetical race. [pick.ts](../packages/gen/pick.ts) explicitly leaves GLB recovery
to picking again; [undo](../packages/cli/mod.ts) only patches JSON/cursor. Rig promotion also writes
the same mutable canonical file before its manifest update.
[promoteToCanonical](../packages/rig/promote.ts).

**Proposed repair:** retain immutable canonical revisions keyed by content hash, and make the
manifest choose a revision. `canonical/model.glb` may remain a compatibility materialization, but
readers must resolve/verify the manifest's asset, and undo/redo must restore that reference and
materialization safely. Keep each transformed pick/rig/identity result, not only the original
generation output: regeneration is not guaranteed to reproduce historical bytes. This extends
existing hash-based assets rather than adding a general asset database.

Acceptance must include pick/rig/retexture/identity → undo → bake, verifying actual mesh and texture
bytes, not just schema-valid JSON. Retain old revisions until unreachable-history cleanup is
explicit and reviewable.

### A2 — Manifest transactions can lose or corrupt history: source-confirmed

`commit()` reads and rewrites journal, cursor, and manifest with no cross-process lock;
`writeAtomic()` always uses the same `.tmp` path. Undo/redo write plain files in
manifest-then-cursor order. These are the prior audit's CORE-P1-1/P1-2, still present in
[receipts.ts](../packages/core/receipts.ts) and [CLI](../packages/cli/mod.ts).

Atomic renaming of individual files is **not** a transaction across three files. Consolidate the
writer, lock per workspace, and specify startup recovery using a committed revision/checkpoint or
transaction record. Decide and document power-loss durability as well as crash safety. A minimal
lock/order fix is useful containment; do not label it complete transactional recovery.

### A3 — Character-local draft state crosses tabs: source-confirmed

The `<Editor>` in [App.tsx](../apps/studio/src/App.tsx) is still unkeyed. The historical audit
traces Look and rig drafts to another character after switching tabs. Key the editor to immutable
workspace identity and make late async results prove their originating workspace/revision before
applying. Rewriting the editor without fixing state ownership would preserve the bug.

These are implementation tasks for F1, not fixes made by this documentation session.

## Make the declared laws operational

**Queries belong in core too.** Studio scans workspaces in Rust and chooses thumbnails/atlases by
newest bake directory mtime, while export follows `lastBakeId`. After undo those can disagree.
Expose a validated workspace/roster status query; route the gallery, current bake, metrics,
staleness, and export resolution through it. Keep large image/model reads as authorized artifact
access, not duplicated product-state logic. [Bridge reads](../apps/studio/src-tauri/src/main.rs),
[roster scan](../packages/core/roster.ts).

**Pins and gates must be load-bearing.** `readPins`/`writePins` have no production callers;
generation checks platform/VRAM but not the full install-time license/territory policy. A run should
resolve an exact model + runtime profile + weight set, validate the receipt and project pin, then
execute. A changed license record is a visible policy change, not an automatic accept.
[Pins](../packages/registry/pins.ts), [generation gates](../packages/gen/gen.ts).

**Choose one job owner.** Do not maintain an unused in-process queue and an assumed desktop queue.
Keep one-shot CLI operation; initially reuse cross-process admission and add explicit job IDs,
cancellation, terminal state, and stderr capture. Introduce a persistent local supervisor only where
warm inference or multiple callers justify it. It must not become a second manifest writer. A worker
retaining weights must keep its VRAM reservation until eviction; releasing the job lease while
leaving weights resident makes admission accounting false.

**Errors must reach users without damaging the stream.** The bridge currently discards stderr and
has no child cancellation. Capture diagnostics separately; preserve valid NDJSON verbatim and attach
raw stderr as diagnostic records rather than fabricating core events. Cancel cooperatively, then
terminate the owned process tree after a grace period; never promote partially written artifacts as
success. [Bridge](../apps/studio/src-tauri/src/main.rs),
[sidecar supervisor](../packages/core/sidecar.ts).

**Keep the trust boundary narrow.** Current desktop configuration has CSP disabled, broad file-read
commands, and an ambient runtime invocation with full permissions. Package known executables,
validate arguments and authorized workspace/model/artifact roots, constrain the webview and remote
navigation, redact credentials, and audit model code/checkpoints as executable inputs. A checksum
establishes identity; it does not prove a malicious artifact safe. Authentication on loopback is
useful defense, not a sandbox against a process with the user's privileges.
[Tauri config](../apps/studio/src-tauri/tauri.conf.json),
[sidecar output discipline](../.agents/skills/sidecar-vram/SKILL.md).

## Proposed target structure

| Boundary              | Ownership and contract                                                                                        | Initial implementation                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Product core + CLI    | Validated manifests, transactional edits, queries, exact model resolution, orchestration, cache, BakeManifest | Confirmed TypeScript; recommend Node LTS, with existing behavior preserved                  |
| Render implementation | Canonical inputs/poses/camera → versioned AOV artifacts and diagnostics; same path for pixel preview and bake | Qualify Node/Dawn first; consider a narrow Rust/wgpu worker only if a documented gate fails |
| Inference runner      | Versioned capabilities and schemas; verified local assets → raw output, metrics, provenance                   | Python per backend, or a proven native runner such as a tested trellis.cpp profile          |
| Desktop               | Windows/dialogs/input, accessible editor state, scoped artifact transport, job display                        | Confirmed Tauri; retain the current React UI and inspection viewport                        |
| Artifact store        | Immutable source/mesh revisions plus derived bakes/cache; manifest chooses current state                      | Files and hashes; no required server or new database                                        |

Use existing file/JSON/NDJSON seams before inventing RPC or per-frame FFI. The render seam already
carries files; keep GPU buffers and decoded frames inside the component doing the work. The existing
three.js viewport remains an inspection instrument; output approval uses core-produced frames.
Preserve the TypeScript importer and retarget/style/pack/export behavior rather than scheduling a
core-language port.

For TypeScript, Tauri's Rust host and inference-worker contracts, export JSON Schema plus
accepted/rejected fixtures; generate bindings where useful, validate at each trust boundary, and pin
canonical serialization behavior. Do not hand-maintain three independent meanings of defaults,
integer ranges, optional fields, or patches. The schema, event protocol, adapter environment,
renderer, and exporter versions are separate axes; one version number should not force unrelated
migrations.

## Performance and determinism

The historical [100-character proof](../docs/internal/proofs/roster100.md) and
[soak evidence](../docs/internal/proofs/soak.ndjson) are useful baselines; they were not rerun here.
The audit's estimated 2.5–4× speedup is a hypothesis, not a new result. Prioritize warm inference,
decoded AOV reuse, avoiding needless PNG round trips, and bounded CPU work after profiling. The
existing readback pool already overlaps GPU submissions; do not claim all GPU work is synchronous
merely because the outer bake loop is serial.

Preserve palette derivation across the full intended frame set, deterministic packing order, and
sequential hysteresis within a direction. Do not parallelize temporal frames independently. A
renderer/runtime change must create a fresh render signature even if the WGSL text is unchanged.
Keep structural checks exact, perceptual checks tolerant, same-machine double-run canaries, separate
software/hardware expectations, and no automatic retries for image tests.
[Render testing rules](../.agents/skills/renderer-golden-testing/SKILL.md),
[style rules](../.agents/skills/npr-sprite-stylization/SKILL.md).

Fixed seeds do not guarantee byte-identical inference across different precision, attention,
CUDA/Metal, model ports, or versions. Record those inputs; never promise cross-runner pixel or mesh
identity without measurements. Keep the original accepted asset so later rebakes do not require
re-running a generative model.

## Distribution is part of the architecture

[release.yml](../.github/workflows/release.yml) builds four CLI zips; it does not deliver the
complete Studio/model environment. [lean.ts](../tools/release/lean.ts) removes the importer to work
around native-module packaging. The Tauri configuration currently targets NSIS, and its CLI bridge
still needs source/Deno. The platform matrix describes targets with explicit gaps, not a
demonstrated clean-machine installer for every feature.

The replacement must install and run offline for mesh → sprites on a machine without source,
Node/Deno on PATH, compilers, or model weights. Package the chosen CLI/runtime/render worker and
assets; provision optional inference separately with pinned compatible binaries. Test spaces and
non-ASCII paths, model-root relocation, Windows packaging identity/AppData virtualization, macOS
signing/notarization, and Linux runtime/webview prerequisites. GPU rendering support and model
inference support need separate matrices. [Current platform support](../docs/platform-support.md).

No new dependency or license exception is adopted by this review. Actual implementation must update
the BOM, append accepted decisions, and synchronize architecture/product docs in the same change.
The [roadmap](roadmap.md) maps the work back to the existing phases.
