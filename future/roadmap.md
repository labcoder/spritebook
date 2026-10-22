# SpriteBook migration roadmap

**Strategy approved: 2026-10-18, D-041 and D-042.** Migrate this repository incrementally. Keep
Tauri, the existing React UI, and the TypeScript product core/CLI. Replace Deno. Do not create a new
repository, a parallel replacement app, or a full Rust/GPUI implementation.

This is the execution plan for that approved direction. **F0 baseline capture is complete as of
2026-10-19; F1 state-safety work, the Windows x64 F2 proof and all F4 tasks are complete, including
the approved Pixal3D integration and hardware/platform spike. F7 release qualification is next.**
The [conformance/platform matrix](baseline.md) records fresh Windows evidence, known defects and
unverified targets. Closing baseline capture does not close platform, installed-app, model or
release qualification gates. A task closes on evidence, not on a compiled binary or an optimistic
support claim. Exact dependency pins and schema changes follow the existing BOM/decision process;
Node/Dawn and the selected Pixal3D recipe have installed Windows x64 / RTX 3090 evidence; other
model/runtime/platform combinations require their own qualification.

## The route

**Required migration: F0 → F1 → F2 → F4 → F7.** Then improve models, the editor and roster scale
through **F3 → F5 → F6**. F-numbers retain the earlier task identities; their numeric order is not
the execution order. Later work must not delay a safe Deno exit.

Use **supported Node LTS** as the replacement runtime target. Qualify **Node/Dawn first**,
preserving the renderer's TypeScript host code and WGSL. If that fails a specific correctness,
platform or packaging gate, stop renderer promotion and investigate a narrow native-worker
contingency. Keep product policy in TypeScript and one production renderer. Do not turn a GPU issue
into another core-language or desktop-toolkit selection.

| Order | Milestone                                   | Depends on                                         | Concrete exit                                                                                                                         |
| ----- | ------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **F0 · Lock the baseline**                  | Approved strategy                                  | Recorded contracts, feature/platform matrix, representative fixtures and current measurements                                         |
| 2     | **F1 · Make state safe**                    | F0 baseline                                        | Recoverable writes and actual asset undo; isolated character/job state; consistent core reads and model resolution                    |
| 3     | **F2 · Prove Node rendering and packaging** | F0 fixtures; F1 before mutating real workspaces    | Actual TypeScript renderer works through Node/Dawn in a Windows x64 installer, with image/structure/performance evidence              |
| 4     | **F4 · Migrate core, CLI and toolchain**    | F1 and F2                                          | One TypeScript core on Node; complete CLI and Tauri integration; tests/tooling/release flows no longer execute Deno                   |
| 5     | **F7 · Release the migrated application**   | F4; required regression and platform gates         | Clean-machine mesh and existing model workflows, preserved workspace conversion/rollback, signed supported artifacts and current docs |
| Later | **F3 · Qualify better model runtimes**      | Migrated baseline                                  | One audited, measured default recipe per claimed hardware tier, complete provisioning and offline inference                           |
| Later | **F5 · Improve the editor**                 | Migrated baseline; F3 where model UI depends on it | Improved six-stage journey, roster workspace and remaining interaction features in the same Tauri app                                 |
| Later | **F6 · Prove expanded production scale**    | F3/F5 and preserved renderer contracts             | New model/UX configuration meets the original sprite, engine and roster budgets                                                       |

**Planning target:** a Deno-free production release by **2027-06-30**, with buffer before the
[upstream support horizon](runtime-migration.md#the-deadline-and-the-actual-dependency). This is an
internal target, not an effort estimate or a license to bypass gates. Re-estimate after F2 using
actual port and packaging measurements. Broader model coverage and a redesigned work surface are not
prerequisites for replacing the runtime.

## F0 · Lock the baseline

- [x] **F0-T1 · Record feature and contract preservation.** Keep the PRD's six stages and eight
      architecture laws. Record representative source images/meshes, accepted assets, rigs, clip
      bindings, looks, identity edits, BakeManifests, engine outputs, CLI twins and public error
      shapes. Link each to a test or an explicit verification gap; do not mark a historical proof as
      rerun.
- [x] **F0-T2 · Preserve and qualify platform targets.** Carry forward Windows x64/ARM64 and macOS
      targets; retain Linux CLI/render support and the documented tier-2 desktop status. Record
      native versus emulated execution and Apple Silicon versus Intel separately. Start hardware
      validation on Windows x64, then execute the same checks on each release target. App/renderer
      availability and model-inference availability remain separate matrices. Missing hardware
      leaves a gate open; it does not silently drop a target or count as a pass. **F0 result:**
      target inventory and the native Windows x64 control are recorded; ARM64, macOS and Linux are
      explicitly unverified here. Their hardware/installed-artifact qualification gates remain open
      in F7, not counted as completed tests by this checkbox.
- [x] **F0-T3 · Record the selected strategy.** D-041 confirms Tauri, TypeScript and leaving Deno.
      D-042 approves incremental migration in this repository. The plan targets Node LTS and
      qualifies Node/Dawn first; no alternative editor or full-core language port is scheduled.
      Preserve the existing source/output licensing distinction and permissive bundled-dependency
      policy.
- [x] **F0-T4 · Capture a reproducible control.** Record the exact baseline commit, toolchain,
      adapter/driver, fixtures, commands and cold/warm results. Include the asymmetric fixture, a
      textured skinned character, an attachment, alpha masking, idle/walk/action clips, non-square
      cells, width 100, and 1×/2×/4× rendering. Preserve old workspaces and exports before any
      migration test.

**Acceptance:** one checked-in conformance/feature matrix and reproducible commands; known defects
and unverified platforms named separately. Do not freeze unsafe behavior as compatibility. Existing
P0–P4 IDs remain useful cross-references, not tasks to reimplement from scratch.

**Recorded exit:** [F0 matrix and replay commands](baseline.md),
[measured control](baseline/windows-x64-vulkan.json), and the
[reusable proof](../tools/proofs/migration-baseline.ts). Six initial test failures were traced to a
missing fixture receipt; the isolated follow-up passes all affected cases. The doctor clear probe
and an in-process GPU validation experiment remain recorded failures. No production behavior
changed.

## F1 · Make workspace and process state safe

Work **F1-T2 → F1-T1 → F1-T3**, then finish the read/policy checks in F1-T4/T5 before runtime
cutover. F2's read-only fixture experiment may run independently; no real workspace conversion
precedes F1.

- [x] **F1-T2 · One recoverable writer.** Consolidate commit/undo/redo persistence in core, protect
      the entire read-modify-write with a per-workspace inter-process lock, use unique staging
      paths, and define recovery across journal, cursor, manifest and asset selection. Reuse proven
      mechanisms where correct. Document process-crash versus power-loss durability. Two writers and
      injected failure at every commit boundary must produce a recoverable prior/new state, never a
      silently lost acknowledged edit or a replayed wrong inverse.
- [x] **F1-T1 · Restore actual assets during undo.** Fix the reproduced pick r1 → pick r2 → undo
      mismatch. Preserve recoverable versions of transformed canonical meshes/textures, not just the
      original generator outputs. Immutable hash-addressed revisions are the implemented storage
      approach; the revision/materialization protocol is documented with F1-T2. Undo/redo after
      pick, rig, retexture and identity edits must restore the bytes consumed by the next bake.
      Aborted promotion cannot replace the last accepted asset.
- [x] **F1-T3 · Isolate editor and job ownership.** Key character-local drafts, reject stale async
      completion for another character/revision, capture stderr without corrupting NDJSON, and make
      cancellation reach the owned CLI/worker process tree. Closing or canceling a job must not
      publish partial assets. Prove tab switching, cancel, process death and retry against
      disposable workspaces.
- [x] **F1-T4 · Make core reads consistent.** Expose workspace/roster/current-bake queries from
      core; use `lastBakeId` consistently in review, thumbnails and export. Preserve existing CLI
      arguments and query-versus-event output contracts. Fix missing/ambiguous valued-flag handling
      where it can silently change a job. Help expansion, aesthetic grammar changes and flag renames
      are later CLI ergonomics work; any future rename needs a compatibility alias.
- [x] **F1-T5 · Make exact execution policy load-bearing.** Resolve project model/pack pins, verify
      install receipts, recheck applicable license/territory/platform gates at job time and use
      config-specific memory claims. Preserve cross-process VRAM admission and the existing sidecar
      contract; do not add a new scheduler to wire the unused queue into production. Invalid pins,
      unaccepted terms, unsupported runtimes and corrupt files must refuse before expensive work.

**Acceptance:** focused crash/concurrency regressions, byte-level asset-history checks, GUI/CLI
state agreement, classified terminal errors, and correct admission/consent checks. Keep existing
valid workflows green. No artifact schema or storage migration may rely on regenerating a historic
AI output. [Evidence and affected modules](architecture-review.md#safety-work-before-migration).

**Recorded exit (2026-10-19):** [F1 completion and validation](state-safety.md). All five tasks are
implemented on main, including crash/concurrency and byte-level history checks, real desktop
cancellation/retry, consistent selected-bake queries, exact execution policy, and the final
creation/no-op/replay regressions. Schema 3 and the sidecar protocol are retained. Deno replacement
had not started at the F1 exit. The subsequent F2 proof is recorded below; the real-model,
power-loss, soak and additional native-platform limits remain explicit release gates.

## F2 · Qualify the Node GPU path and installed layout

**Scope confirmed 2026-10-19:** finish this proof on the available Windows x64 machine. Defer native
Windows ARM64, macOS ARM64/Intel and Linux qualification to **F7-T1/T2**; they remain product
targets with open release gates. F4-T4 carries the Node build and non-GPU checks into the existing
GitHub Actions OS matrix. Linux lavapipe can exercise software rendering there. Hardware image,
performance and installed-app checks require a functioning native adapter and desktop environment; a
green build alone does not qualify them. See
[the runner plan](renderer-qualification.md#deferred-platform-checks).

- [x] **F2-T1 · Run the real renderer on Node/Dawn.** Use a bounded adapter/environment experiment
      in this repository; keep existing production modules as the control. Exercise MRT AOVs, WGSL,
      upload/skinning/attachments, alpha, padded readback, styling and atlas output. Carry the exact
      structural assertions and same-machine double-run canary; review old/new image differences
      with the existing tolerant-golden discipline. Record memory, cold/warm wall time and
      throughput. Use the
      [runtime gates](runtime-migration.md#renderer-trial-one-representative-workload), including a
      proposed ≤10% end-to-end regression budget on the same workload or an explicit recorded
      exception. Start with 3–5 engineering days for the experiment, then re-estimate from evidence.
- **F2-T2 · Retired: alternative desktop trial.** Tauri is selected; this ID remains withdrawn. No
  GPUI/native-inspector work is hidden inside the migration.
- [x] **F2-T3 · Prove delivery early.** Package an app-owned Node runtime, compiled JS, Dawn native
      library and required shader/decoder assets. Launch through Tauri resource paths without
      source, development node_modules, Deno/Node on PATH, compilers or an untracked shared cache. A
      runtime directory is acceptable; do not require a single-file executable. Audit native
      notices/required shared libraries and execute the Windows x64 installer. Record unresolved
      prerequisites and redistribution blockers for F7; this proof does not authorize distribution
      or additional support claims.

**Acceptance:** a written pass/fail report, artifact paths and reproducible runs. A source build,
triangle demo, generic addon CI matrix or cache hit is not a qualified SpriteBook renderer. Device
loss, no-adapter, cancellation and native-addon load failure must be visible and leave prior
artifacts usable. If a gate fails, document the precise blocker before funding a native render
worker; no full Rust core, new repository or toolkit change is the fallback.

**Recorded exit (2026-10-19, Windows x64 scope):**
[Renderer qualification](renderer-qualification.md) and
[sealed measurements/artifact receipt](qualification/windows-x64.json). The bounded Node/Dawn
candidate, with Node-native PNG encoding, passes 110 carried assertions, decoded-pixel comparisons
and the paired Vulkan performance budget. The unchanged-code experiment first missed the 4x budget;
profiling and the measured codec change are recorded, without a waived gate or changed golden. Final
cold medians improve by **12.7–16.1%**, and all 40 compared pages match decoded pixels exactly. The
Unicode-path NSIS install passes all 110 carried checks, missing-addon/loader exit-status checks,
native device loss, owner death during rendering and retry, with prior bake bytes unchanged. The
native notice audit records unresolved release blockers. **F2 is complete within its approved
Windows scope; next is F4-T1.** Additional native platforms, clean-machine prerequisites, signing
and redistribution clearance remain F7 gates. Production still uses Deno; no runtime or renderer
promotion is implied.

## F4 · Migrate the existing TypeScript core and Tauri bridge

Keep each behavior-changing package group and each toolchain switch in its own reviewable change.
Avoid dependency upgrades that are unrelated to the runtime move.

- [x] **F4-T1 · Port the contract/test foundation.** Keep schema ownership in `packages/schema`.
      Establish package exports and a locked npm workspace, compile shipped JavaScript, and retain a
      separate TypeScript check. Port fixture/schema tests first, using a single JS test runner
      (`node:test` if sufficient); retain cleanup/leak checks and honest GPU skip/fail semantics.
      Verify accepted/rejected documents and canonical serialization against the control.
      **Progress:** locked npm workspaces and default compiled package exports are established; all
      30 existing schema/fixture/migration assertions pass on emitted JavaScript through
      `node:test`, with a separate TypeScript check. The full runner discovers the package, GUI and
      proof tests, enforces cleanup checks and marks GPU/model/desktop skips explicitly. No global
      Deno adapter is used.
- [x] **F4-T2 · Port runtime-bound calls in package order.** Keep algorithms and package boundaries.
      Convert filesystem/process/env/path/error handling in `core` and `registry`; then `importer`,
      `gen` and `rig`; `anim`/`style`; `pack`/`export`; and `cli` composition. `schema` is covered
      by F4-T1 and `render` by F4-T3. Each group keeps its existing fixtures and gains Node
      execution before the next group's cutover. Consolidate only genuine shared policy such as
      transactions and subprocess ownership; no permanent global Deno shim. Preserve canonical
      glTF/FBX behavior, retarget-once, palettes/temporal ordering, deterministic packing and CLI
      twins. **Recorded package exit:** all 13 packages compile to JavaScript and declarations, with
      a separate source/test type check. The final Windows checks pass **896 of 903 cases**, with
      **7 explicit skips** for real-engine, real-model, weight-gated and desktop lanes. This
      includes the GUI logic/parity suite, crash/concurrent-writer recovery, asset undo,
      independent-process VRAM admission, synthetic sidecar inference and sidecar death/retry. The
      Node resource guard rejects referenced-handle leaks; explicit descriptor/process regressions
      cover the boundaries Node's resource inventory cannot see. Installed delivery and real-model
      checks remain below.
- [x] **F4-T3 · Promote the qualified renderer.** Integrate the F2 path through the existing render
      seam. Assign a fresh renderer signature/cache namespace, including build/backend/adapter and
      available driver identity. Never reuse old cached frames as evidence of Node rendering. Keep
      existing bakes and accepted model assets; provide a compatible export/read path rather than
      deleting them to make migration pass. One path serves core pixel preview and baking. Carry the
      qualified PNG boundary and 8/16-bit/CRC assertions into the real Node modules; remove F2's
      environment shim and build-time import substitutions. Preserve fresh `Uint8Array` copy and
      alignment semantics in binary readers when replacing Deno file reads with Node buffers.
      **Progress:** the compiled Node/Dawn renderer passes 59 Windows Vulkan checks, including
      padded readback, materials, attachments and independent 8/16-bit PNG/CRC checks. Renderer
      0.6.0 hashes Node/Dawn, codec, backend and adapter/available driver information into a fresh
      cache identity. The [paired production replay](runtime-cutover.md) passes 40/40 pixel-exact
      atlas pages and 15/15 F0 comparisons, with cold medians 12-15% faster. Old bakes remain
      readable and the original control stays sealed.
- [x] **F4-T4 · Switch application, tooling and release execution.** Make Tauri invoke bundled
      runtime/core entry points rather than `deno run -A` against a checkout. Switch web build
      hooks, CLI commands, test/lint/format/type-check tasks, CI guards, proof helpers, hooks and
      release builds. Close the observed Vite optimizer stall and Rust-target watcher failure; the
      F1 desktop proof used a temporary watch exclusion, not a delivery fix. Preserve scoped
      args/artifact access, per-job streams and owned worker cleanup. Ship the importer and required
      native assets; retain qualified Windows loader layout, Unicode-path handling and failure
      diagnostics. Retire the lean-tree importer omission. Preserve current Python/uv adapters and
      handshake compatibility, with a clear installed-environment path. Make current adapters'
      declared assets and authentication work from a fresh install. Minimum provisioning fixes
      needed by existing models belong here; they cannot be deferred merely because F3 includes
      broader model-management improvements. **Progress:** the owned runtime/uv/package tree, Tauri
      bridge/hooks, portable body ID, Vite optimizer/watch fix, frozen writable environments, Hub
      auth and Node CI/candidate workflows are implemented. The final 6,149-file Windows NSIS
      payload passes outside-checkout Unicode/empty-PATH import, synthetic generation, Track A
      rigging, core preview, styled/AOV bake and all four exporters. Fresh Python 3.11.16 setup,
      native Tauri projections/health, cancellation/retry and real U²-Net prep pass. Installed
      Python uses normal wheels; the bounded Triton/TinyCC compatibility fix passes cold Unicode
      native compilation. Complete catalog versions provision pinned TRELLIS.2/UniRig sources and
      separate frozen environments. Decoder/conditioner loading is local-only. Restricted NVIDIA
      rasterizers and the historical OPT config are replaced without a license exception; custom
      DINOv3 terms remain explicit. The real installed generation/pick → retexture → UniRig → core
      preview → 144-frame styled/AOV bake → four exporters passes offline, with 100% warm-cache
      hits. Worker death/retry and source corruption/repair preserve accepted assets and prior
      bakes. The [completed model gate](model-provisioning-gate.md) records exact artifacts, review
      advisories and [qualification evidence](qualification/model-workflow-windows-x64.json). See
      also [cutover evidence](runtime-cutover.md).
- [x] **F4-T5 · Prove conversion, rollback and legacy retirement.** Validate a preserved workspace
      copy before changing it. Preserve IDs, source/assets/history and readable exports; reject
      future schemas honestly. Test interrupted installs, corrupt receipts, disk-full commits,
      spaces/Unicode paths, model-root relocation and Windows AppData virtualization. Reopen the
      original copy in the old release. Remove Deno from supported dev, CI, packaging and production
      flows only after the replacement passes; archive the pinned legacy build for
      conversion/reference, not normal use. **Progress:** preserved-copy conversion, asset/export
      preservation, future-schema refusal and reopening original/converted copies in the archived F1
      release pass. ENOSPC and interrupted builder publication recover coherently. Deno configs, F2
      shims and importer-less release tooling are retired. The installed payload passes corrupt
      receipt, missing addon/loader, model-root relocation and owner-death/retry checks; prior bakes
      remain unchanged. The native app reports an unvirtualized model root and the existing
      virtualization guards pass. Private NSIS install/uninstall both exit 0. Full installer
      upgrades, signing and clean-machine qualification stay in F7.

- [x] **F4-T6 · Integrate Pixal3D through model management.** Pin the official single-view weights,
      DINOv3 conditioner, real NAF upsampler, source and frozen Windows runtime. Keep terms gates,
      offline loading, prebuilt native dependencies and canonical glTF at the importer border.
      Qualify generation on the maintainer's RTX 3090 (24 GiB), including measured load/inference
      memory, PBR output, candidate selection, sprite workflow and recoverable failure. Preserve the
      existing TRELLIS.2 default and completed migration evidence. A duplicated-feature NAF fallback
      does not qualify as Pixal3D integration. **Recorded exit:**
      [installed qualification](qualification/pixal3d-windows-x64.json) and
      [hardware/review report](model-platform-spike.md). The 6,157-file NSIS runtime passes
      Unicode/empty-PATH setup, real single-view PBR generation, pick, UniRig, core preview,
      144-frame styled/AOV bake, four exporters and native Tauri model-manager/read projections.
      Warm hits are 100%; all five AOV pages remain byte-identical after rig acceptance. Worker
      death/retry and source corruption/repair preserve accepted assets. Both candidates' raw and
      canonical GLBs repeat byte-for-byte in fresh workers after replacing non-repeatable GPU
      reduction/normal sums with bounded CPU processing. No default or terms gate was relaxed.
- [x] **F4-T7 · Spike practical image-to-3D alternatives.** Investigate open models against the
      maintainer's Windows x64 / RTX 3090 / 64 GiB RAM machine. Run realistic candidates where their
      assets, terms and prebuilt runtime permit; record failures as well as successful outputs.
      Finish with a sourced Windows/macOS/Linux matrix covering exact runtime variants,
      GPU/unified-memory requirements, system RAM, disk, output texture support and licensing.
      Distinguish local measurements, upstream claims and community ports. Native Mac/Linux
      qualification remains F7; neither research nor a hosted build proves GPU inference there.
      **Recorded exit:** the [hardware/platform spike](model-platform-spike.md) measures Pixal3D and
      two TripoSR inputs on the RTX 3090, with reviewed core renders and explicit evaluation
      changes. It records named Mac MPS/MLX/Metal and Linux CUDA/AMD runners, GPU/unified-memory
      claims, system-RAM/disk gaps, exact downloads and code/weight/output terms. TripoSR remains a
      spike, not a catalog backend. Prioritize it, then SF3D/SPAR3D, for F3's lightweight
      comparison.

**Acceptance:** the installed CLI and Tauri app use one TypeScript core on Node, import a mesh,
retarget clips, bake styled/AOV atlases and export every existing target. Existing real generation
and rigging workflows pass their applicable hardware/terms gates without undeclared downloads.
Source, tests, hooks, CI and release execution no longer require Deno. Historical proof transcripts
may still contain Deno commands when clearly labeled historical; executable support paths may not.
The maintainer confirmed on 2026-10-19 that the existing model provisioning/licensing gate stays in
F4. **That gate, the Pixal3D extension and the model spike now pass; F4 is complete within the
approved Windows x64 scope.** F7 retains the release and deferred native-platform checks. Carry the
inspected rig's stretch/unmapped-joint advisories into F3-T1 quality qualification;
review/acceptance and measured defaults remain intact.

## F7 · Release the migrated application

This is a migration release preserving current behavior, not a requirement to finish every new model
integration or UI feature first. F3/F5/F6 improvements follow it.

- [ ] **F7-T1 · Publish only verified artifacts and support claims.** Clean-machine install and run
      on Windows/macOS targets and the declared Linux tier. Include runtime/native binaries,
      shaders, codecs/importer, docs, notices and version checks. Separate renderer support from
      exact model support. Test the existing mesh → animated sheet → engine workflow, current
      sidecar generation/ rigging where supported, adaptive and fixed-palette styles, AOV layout,
      warm-cache hits and a representative roster rebake. Run actual engine imports for supported
      claims; unresolved lanes such as Unity must stay explicitly unverified rather than silently
      passing. Run the deferred F2 workload and installed-failure checks natively on Windows ARM64,
      macOS ARM64/Intel and Linux, recording adapter/backend, image comparisons, memory and
      cold/warm timings separately. Use Linux lavapipe for software checks and hardware runners for
      GPU/performance claims. Complete native notice clearance and runtime prerequisite provisioning
      before any artifact is distributed.
- [ ] **F7-T2 · Exercise installed-app recovery.** Test signing/notarization, upgrade/uninstall,
      application-owned executable discovery, model/log storage, cancellation, workspace conversion,
      preserved-copy rollback and cache invalidation. Repeat keyboard/focus/IME and existing locale
      coverage; native VoiceOver/NVDA and any claimed Linux assistive-technology path need actual
      tests. Test viewport lifecycle and an 8-hour soak on the migrated baseline before making scale
      claims.
- [~] **F7-T3 · Synchronize the public and contributor contracts.** Update README, setup/quickstart,
  CLI guide, platform matrix, BOM, architecture, versioning, active roadmap and affected agent
  skills with the implemented Node path. Append decisions, preserve old proof logs as historical,
  and publish measured limitations. Runtime changes do not silently change model/output terms.

  **Current documentation pass (2026-10-19):** architecture, source schema references, model
  setup/storage/removal, usage guides, platform claims, dependency/version records and consumer
  checks are aligned with the implemented Windows baseline. The PRD/design system retain future
  product goals separately from current behavior. Reconcile the final guides and candidate payload
  docs with F7-T1/T2 results before public release; those qualification gates remain open.

  **Remote-history reconciliation:** the [25-commit review](remote-main-review.md) selects this
  TypeScript/Node history as main and preserves the independent remote implementation in a verified
  local recovery bundle. Useful behavior is adapted through current contracts. Studio now exposes
  the existing `models setup` runtime repair action with explicit consent; broader inventory and
  editor cases remain in the later tasks below. Publishing and hosted CI must validate the
  consolidated head; they do not close native release gates.

**Release gate:** required target artifacts are executed, data recovery and engine outputs pass,
mandatory suites are green, and no advertised support rests on a skipped check. Retain original PRD
performance budgets on the same reference workload: ≤10 min mesh → sheet, ≤30 min image → engine
where that model tier is claimed, 100-character style pivot overnight, and the defined ≤1.2% idle
flicker budget. No cross-machine byte-equality promise or image-suite auto-retry.

## Later work · F3, F5 and F6

These tasks preserve the broader product vision. They are not conditions for completing the Deno
migration. Minimum fixes required by current workflows or the clean-install release gates remain
F4/F7 migration work, even when they touch the same modules as these later improvements.

| Tasks            | Deliverable                                                                                                                      | Acceptance                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F3-T1**        | Compare current TRELLIS.2/Pixal3D, then TripoSR and gated SF3D/SPAR3D; assess native/Mac/Hunyuan recipes from the hardware spike | Sprite-sized identity/deformation/material quality, fresh-regeneration repeatability, memory/time, clean setup and exact terms; preserve defaults until qualified             |
| **F3-T2**        | Complete Hub/auxiliary-model provisioning, gated auth, resume, disk planning, hash receipts and existing offline import          | Full chosen workflow runs with outbound network blocked and an unrelated/empty HF cache; removal touches only owned files                                                     |
| **F3-T3**        | Warm worker reuse, visible eviction and bounded environment profiles                                                             | Retained weights keep their memory claim; cancel/death/retry and 10/100-character runs remain correct                                                                         |
| **F3-T4**        | Preserve universal mesh/imported-rig/body-fit paths and expand Apple Silicon/AMD inference where proven                          | Exact model + runner + hardware passes canonical import, rigging and sprites; fixtures remain clearly synthetic                                                               |
| **F3-T5**        | Optional text → approved reference → 3D with a separately audited image model                                                    | Record prompt, models, seeds and image hash; retain image input and avoid silent cloud fallback                                                                               |
| **F5-T1**        | Roster overview, character-scoped six-stage layout, early pixel strip and source comparison                                      | Preserve the current Tauri/React implementation, design/accessibility contracts and every core/CLI capability                                                                 |
| **F5-T2**        | Remaining CC0 clip-library/player/QA/identity improvements, keyboard joint adjustment and baked-sprite sandbox                   | Per-clip frames/speed/hold-last, mirroring opt-in, source details, undo, flags and CLI twins work end-to-end; personal clip imports remain non-redistributable where required |
| **F5-T3**        | Full interaction polish, localization expansion and viewport lifecycle verification                                              | Keyboard, real assistive technologies, IME, reduced motion, themes, drag/drop and +40% copy expansion pass                                                                    |
| **F5-T4**        | Further installer/updater and platform integration improvements                                                                  | Clean upgrade/rollback and safe paths on claimed targets; required migration delivery is already covered by F4/F7                                                             |
| **F6-T1, F6-T2** | Expanded identity, motion and pixel-style qualification                                                                          | Asymmetric marks/prosthetics, root/feet, thin features, palettes, alpha, outline, all directions and aligned AOVs survive actual sprite-size review                           |
| **F6-T3**        | Higher roster throughput and resource efficiency                                                                                 | Cold/warm/single-edit/style-pivot predictions and 8-hour soak pass; preserve palette scope and temporal frame order while profiling before parallelism                        |
| **F6-T4**        | End-to-end production workflow qualification                                                                                     | Props, asymmetric animated characters, roster recovery and engine playback pass with setup/inference/bake costs reported separately                                           |

### Retained model and editor cases

**F5-T1 visual slice, 2026-10-20:** the maintainer approved Imprint for implementation on main.
Studio now has paired light/dark roles, a compact title bar, loaded-character index, horizontal
six-stage navigation, a disclosed inspector and source/saved-sprite comparison before Look's recipe.
The shared Bake player supplies synchronized comparison views at integer zoom; core/CLI behavior and
journaled edits remain authoritative. Model management, logs, locale and command palette use the
same identity. Browser replay evidence uses prior bake `acc25412`; it is not new inference or native
release qualification. F5-T1 remains open for the broader roster and early preview work; F5-T2/T3
and F7 keep their interaction, lifecycle and native accessibility gates.

**F5-T1 generation follow-through, 2026-10-20:** opaque sources now run the existing gated U²-Net
preparation job inside core generation. Original references remain intact; the journal records the
prepared PNG hash, model version and parameters, and retries reuse verified cutouts. Both Studio and
the CLI use that path. Keep source/prepared-mask inspection in the remaining editor work: the
reported green-screen reference shows U²-Net residue between the legs and soft hand edges. A Windows
RTX 3090 replay of that opaque RGB reference completed both 16-step, 800,000-polygon candidates in
390.02 seconds; the one-body second candidate ranked ahead of the two-body first. This verifies the
core generation flow, with native UI/release qualification still open.

**F5-T1 candidate-save correction, 2026-10-20:** saving a generated candidate now preserves its
bytes by default in core, CLI and Studio. Source-colour matching and detail reprojection remain
explicit texture-change options. A successful save shows the canonical asset immediately. The
reported Bulma mismatch had identical r1 geometry but a repainted colour texture; acceptance and
CLI-twin checks cover byte preservation, explicit repainting and reversible promotion. This does not
qualify the remaining rig, animation or native release paths.

**F3-T2 / F5-T1 model-management follow-through, 2026-10-20:** one platform-compatible managed build
is recommended per model, with historical builds under Other versions. Core exposes runtime
preparation separately from weight receipts, rejects empty environments left by cleanup, and checks
Blender with a disposable mesh artifact during UniRig setup. Installation streams real download
bytes and named setup phases; Studio shows activity immediately and keeps diagnostics, consent and
CLI twins available by disclosure. Reusing the existing checkpoints repaired the maintainer's UniRig
runtime. An isolated Bulma rig completed in 187.64 seconds with 52 joints, finite weights and no
zero-weight vertices; its 24 deformation flags remain a rig-quality review case for F5-T2. Native
dialog/assistive-technology and clean-machine release qualification remain F7 work.

**F5-T1 workbench polish, 2026-10-21:** retain Imprint's typography, semantic palette and textures;
use the maintainer-approved canvas-left/settings-right arrangement through Rig. Gallery uses the
full window without duplicating its cards in a roster. The flush stage rail also appears during
creation. Grouped property panels, native model/track radios, advanced disclosures, visible action
footers and a compact candidate filmstrip replace the loose forms. Rig keeps its actual deformation
report below the canvas and explicit acceptance beside repairs. Generation/rig jobs show reported
phases and elapsed time; unequal stage costs remain indeterminate. Cancellation has its own focused
status. These changes preserve catalog defaults, core verbs, asset bytes and the later-stage feature
scope. This UI pass does not resolve the existing deformation flags or close F5/F7 qualification.

The [remote-history review](remote-main-review.md) carries useful requirements into these tasks
without adopting another core, project format, renderer or provisioning stack:

- **F3-T1 / F5-T2:** compare dense sources and budgeted working meshes, manual proportion/weight
  fitting and Make-It-Animatable as an unqualified rigging candidate. Audit exact terms and measure
  hardware before any catalog addition. Include upright asymmetric clothing, tilted/turned bind
  frames, folded knees and source-informed knee guidance; preserve geometry/UVs and reversible
  edits.
- **F3-T2 / F5-T1:** distinguish installed weights from runtime readiness and partial/unreadable
  inventory. Runtime repair is exposed now; resume, disk reporting and shared-dependency removal
  need their own ownership/recovery evidence.
- **F5-T1/T2 / F7-T2:** review candidate idle/walk/action before acceptance, restore exact rest or
  playback state, and preserve successful candidates through later failures and project moves. Keep
  visible batch progress/cancel/retry tied to core jobs and the current project.
- **F5-T2:** add explicit current/selected/all library batch controls through core/CLI. “All” means
  the full library and chosen directions, regardless of search/checkbox filters. An FPS change must
  invalidate incompatible frame-index exclusions and duration overrides before enqueue.
- **F6-T1/T2:** compare deformation, linear-light/material/light/shadow behavior and transparent
  edges at sprite size using the existing renderer and structural/golden checks.

### Workflow qualification

F6-T4 qualifies complete production workflows on the same inputs and hardware: a textured prop
through eight directions; an asymmetric humanoid through idle/walk/action; a roster look change with
failure/restart; and engine playback with pivots, timing and aligned passes. Report setup, download,
cold inference, warm inference and sprite-bake time separately. Include silhouette, stray-pixel and
baseline QA without rejecting legitimate poses or asymmetric attachments. A node that runs
successfully is not evidence that the complete character workflow is ready.

## Feature preservation map

| Existing capability                                                      | Migration protection                                                | Later improvement                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------- |
| Six stages, CLI twins, core-owned state                                  | F0-T1, F1-T3/T4, F4-T2/T4, F7                                       | F5-T1/T2                           |
| Schema, immutable IDs, history, accepted assets                          | F1-T1/T2, F4-T1/T5                                                  | F5 recovery UX                     |
| Canonical glTF/importer/FBX, Tracks A/B, identity layers and attachments | F0 fixtures, F1-T1, F4-T2/T4, F7-T1                                 | F3-T4, F6-T1                       |
| Clip packs, semantic retargeting and shared preview/bake poses           | F0-T1/T4, F4-T2/T3, F7-T1                                           | F5-T2, F6-T1                       |
| Render/NPR, world scale, palettes, temporal stability and AOV packing    | F2-T1, F4-T3, F7-T1                                                 | F6-T2/T3                           |
| Registry, exact pins, policy gates, VRAM and inference seam              | F1-T5, F4-T2/T4, F7-T1                                              | F3-T1/T2/T3                        |
| Cache, stale planning, batch and roster reporting                        | F0-T4, F4-T2/T3, F7-T1/T2                                           | F6-T3                              |
| Godot/Aseprite/TexturePacker/strips and output timing                    | F0-T1, F4-T2/T5, F7-T1                                              | F6-T4                              |
| Tauri themes, locale/focus contracts, logs and inspector disposal        | F1-T3, F4-T4, F7-T2                                                 | F5-T1/T2/T3                        |
| P0–P4 product goals and recorded proofs                                  | Retain original task IDs and evidence; update active index at F0/F7 | F3/F5/F6 finish the broader vision |

## First implementation changes

1. **Completed — F0:** current control, conformance fixtures, feature/platform checklist and
   preserved local workspace/export backup are recorded in [the baseline](baseline.md).
2. **Completed — F1:** recoverable writes, byte-correct asset undo, job/editor isolation, consistent
   reads and execution policy are recorded in [state safety](state-safety.md).
3. **Completed — F2:** the Windows Node/Dawn slice and installed proof pass. Additional native
   targets are deferred to F7, as confirmed above.
4. **Completed — F4:** package, renderer, application/tooling and Windows installed proofs pass,
   including existing-model provisioning/licensing, Pixal3D integration, real offline inference,
   byte-exact fresh-worker replay, recovery and the model hardware/platform spike.
5. **Next — F7:** qualify release artifacts, additional native platforms, clean-machine
   prerequisites, signing and upgrades. Put unrelated model, editor, dependency and performance work
   in the later tasks above.

Use these task IDs in implementation changes, include the relevant original P-task IDs where
behavior is carried forward, and update the progress log with actual measurements and remaining
gates. F0 records the legacy implementation; F1 and the Windows F2 proof are complete. Main now uses
Node; the completed F4 model gate and remaining F7 release gates are recorded in the
[cutover report](runtime-cutover.md).
