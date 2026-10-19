# F0: legacy baseline and preservation matrix

Recorded **2026-10-19**. F0 captures what must survive the migration and what the current checkout
can actually prove. It does **not** certify every platform or make existing defects compatible
behavior. Tauri, the TypeScript core/CLI and incremental migration remain selected (F0-T3,
D-041/D-042). No production code, dependency, schema or golden changed during F0.

The product source is `42be3bbebfc783edb42fb64001aa9b2e3d638c98`; the control runner is committed in
`68bad07`. That commit adds only the approved future documents and the proof to the product source.
[Measured evidence](baseline/windows-x64-vulkan.json) pins the complete checkout, toolchain, driver,
input hashes, commands, results and preserved local archive. The JSON is an observation, not a new
product schema.

## What ran

- The existing full suite, with Vulkan and `SPRITEBOOK_REQUIRE_GPU=1`: **817 passed, 6 failed, 5
  ignored**, with 33 passing steps. Every failure came from a generation path using the missing
  default `fixture-gen` installation. The six cases span CLI twins, animation preview and VRAM
  admission. This is an environment prerequisite the affected tests do not provision themselves.
- Install the weightless fixture's receipt in an isolated model root, then run the three affected
  test files: **8 passed, 0 failed**, including all six previously failing cases. No production
  patch, model-weight download, test relaxation or image auto-retry was used. This is a qualified
  follow-up, not a claim that the original full invocation passed.
- The legacy control below: fresh CLI processes, 96 frames at each of 1x/2x/4x, five AOVs, cold
  caches followed by 100% warm hits, identical cold/warm atlas bytes and all four exporter outputs.
  A second independent control verifies replay against the first; both originals remain local.
- Studio `check:web`, `build:web`, and offline locked `cargo check` pass on Windows x64. The web
  build reports its existing large-chunk warning. Compilation is not a packaged-app/UI test.
- Repository-wide formatting and lint checks are **already red**: eight unchanged files fail
  formatting, and `apps/studio/bake_test.ts:6` has an unused `assert` import. F0 files pass their
  scoped checks; these unrelated baseline failures were recorded rather than folded into F0.
- `doctor --sidecar --json` exits **1**: the sidecar handshake passes, but the clear probe reports
  `validation error occurred`. The available adapter and successful full render workload do not turn
  this diagnostic failure into a pass.

Explicitly ignored: real TRELLIS.2/UniRig acceptance, Godot, Aseprite, Phaser and Unity consumers.
Additional opt-in bodies report that they asserted nothing: the desktop CDP journey, local U2-Net
inference and the two-process lease integration. Their surrounding files may print `ok`; those
particular assertions were **not executed**. Historical model, engine, roster and accessibility
proofs remain historical.

The quiet replay measured the following total CLI wall times; all rows have 96 frames and 0%/100%
cold/warm cache hits. Both independent runs reproduced all atlas hashes and **31 export files**.

| Supersampling | Cold     | Warm    |
| ------------- | -------- | ------- |
| 1x            | 5.273 s  | 3.033 s |
| 2x            | 6.808 s  | 2.924 s |
| 4x            | 12.300 s | 2.904 s |

## Product and feature preservation

**Evidence key:** `suite` means existing assertions ran in the full invocation; `follow-up` means
the fixture-qualified run; `control` means the saved workload. Passing a source test does not imply
that an installed desktop app or external engine has been exercised. P-task references retain the
original product scope; unfinished UX remains in F5, not an excuse to lose working behavior.

| Contract or capability                                                                     | Existing verification / representative artifact                                                                                                                                                                                                                    | F0 result and migration obligation                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source image, canonical source mesh; immutable ID and rename/clone                         | [workspace](../packages/core/workspace_test.ts), [roster](../packages/core/roster_test.ts), [importer](../packages/importer/mod_test.ts); [source/schema example](../packages/schema/fixtures/valid/character-manifest.json)                                       | Suite; keep IDs, source bytes and provenance. Source mesh CLI/GUI intake needs installed end-to-end proof, not just importer tests. P1-T2/T4, P3-T2.                                                                        |
| 01 Generate: preflight, candidates, seed, count, operation-specific settings, retexture    | [generation acceptance](../packages/gen/acceptance_test.ts), [operation params](../packages/gen/opparams_test.ts), [retexture](../packages/gen/retexture_test.ts), [CLI twins](../apps/studio/parity_test.ts)                                                      | Suite + follow-up + synthetic control. Real model quality/provisioning was not rerun. P3-T2.                                                                                                                                |
| Pick/save canonical mesh, accepted asset hash and generation lineage                       | [receipts](../packages/core/receipts_test.ts), [generation metadata](../packages/gen/genmeta_test.ts), [saved character](baseline/character.json)                                                                                                                  | Suite + control. Preserve selected bytes as well as metadata; asset undo is a known defect below. P3-T2.                                                                                                                    |
| Canonical glTF border: GLB/glTF, FBX, OBJ, VRM, orientation/scale/skin validation          | [importer acceptance](../packages/importer/mod_test.ts), [components](../packages/importer/components_test.ts)                                                                                                                                                     | Suite includes double imports. Keep the interim FBX converter behavior pending a separately qualified replacement; installed importer currently has a delivery gap. P1-T4.                                                  |
| 02 Rig: Track A roster fit, source skin, Track B, acceptance and repair                    | [fit job](../packages/rig/fitjob_test.ts), [repair](../packages/rig/edits_test.ts), [orientation](../packages/rig/orient_test.ts), [promoted bake](../packages/rig/promoted_bake_test.ts)                                                                          | Suite + Track A control. Track B adapter/real deform quality is unverified this session. Fitted synthetic control has explicit quality warnings. P3-T3/T4.                                                                  |
| 03 Animate: packs, per-clip enable/frames/speed/hold, import and retarget                  | [bindings](../packages/cli/anim_bindings_test.ts), [pack](../packages/anim/pack_test.ts), [retarget](../packages/anim/retarget_test.ts), [sampling](../packages/anim/sample_test.ts)                                                                               | Suite + idle/walk/action control. Preserve personal-pack redistribution boundaries. P3-T1.                                                                                                                                  |
| Shared preview/bake retargeting, foot/root behavior, semantic bone mapping                 | [preview parity](../packages/anim/preview_test.ts), [bake integration](../packages/anim/bake_integration_test.ts), [CLI preview](../packages/cli/anim_preview_test.ts)                                                                                             | Suite + follow-up; keep core-produced clips and continuous poses. No GUI-owned retargeting. P3-T1.                                                                                                                          |
| 04 Look: preset/override resolution, directions, world scale, pivot, non-square cells      | [CLI look](../packages/cli/look_test.ts), [camera](../packages/render/camera_test.ts), [framing](../packages/render/render_test.ts), [saved look](baseline/character.json)                                                                                         | Suite + 100x128 control at 32 px/m and padding 16. Keep manifests authoritative. P2-T1/T2, P4-T2.                                                                                                                           |
| Render: 1x/2x/4x, MRT lit/albedo/normal/depth/coverage, textured skin, alpha masking       | [render](../packages/render/render_test.ts), [material](../packages/render/material_test.ts), [skinning](../packages/render/skinning_test.ts)                                                                                                                      | Suite + control. Width-100 strip reference, per-pass masks and factors pass; clear-probe failure remains separate. P2-T1.                                                                                                   |
| Pixel/cel/painterly/clean looks, outlines, palettes, dithering, alpha bleed                | [pipeline](../packages/style/pipeline_test.ts), [goldens](../packages/style/goldens_test.ts), [multi-clip palette](../packages/style/multiclip_test.ts)                                                                                                            | Suite. Fixed/adaptive membership, temporal guards and committed-fixture perceptual checks pass. No golden updates. `clean` needs its own perceptual flicker metric; a mixed action clip bake is not the idle budget. P2-T2. |
| Asymmetric identity: decals, bone masks and socket attachments; mirroring opt-in           | [identity](../packages/gen/identity_test.ts), [identity jobs](../packages/gen/identityjob_test.ts), [tattoo acceptance](../packages/pack/tracka_test.ts), [attachment GPU check](../packages/render/attachment_test.ts), [mirror](../packages/pack/mirror_test.ts) | Suite. Attachment position is checked against the joint; asymmetric tattoo A/B uses shipped albedo. These fixtures are separate from the timed control. D-008, P3-T4.                                                       |
| 05 Bake/review: canonical manifest, per-clip timing, parallel atlas layout, contact sheets | [integration](../packages/pack/integration_test.ts), [manifest](../packages/pack/manifest_test.ts), [contact sheets](../packages/pack/contactsheet_test.ts), [saved BakeManifest](baseline/bake.json)                                                              | Suite + control. Preserve rect identity, timing and readable old bakes. Interactive player source tests pass; the desktop sandbox journey is not freshly exercised. P2-T3, P4-T2.                                           |
| Input cache, provenance, single-edit invalidation and roster plans                         | [cache](../packages/pack/cache_test.ts), [clip bytes](../packages/pack/clipcache_test.ts), [provenance](../packages/pack/provenance_test.ts), [batch](../packages/cli/batch_test.ts)                                                                               | Suite + 0%/100% control. 100-character pivot and 8-hour soak were not rerun. P2-T3, P4-T3.                                                                                                                                  |
| 06 Export: Godot, Aseprite, TexturePacker, strips; timing/pivots/loops                     | [export tests](../packages/export/mod_test.ts), [Godot](../packages/export/godot_test.ts), [Aseprite](../packages/export/aseprite_test.ts), [strips](../packages/export/strips_test.ts)                                                                            | Suite + all four generated outputs retained. Actual consumers remain unverified this session; do not turn generated files into an engine-support claim. P2-T3.                                                              |
| Catalog/pins/install verification, operation schema, terms/platform/VRAM gates             | [registry gates](../packages/registry/gates_test.ts), [install](../packages/registry/install_test.ts), [capabilities](../packages/registry/capabilities_test.ts), [pins](../packages/registry/pins_test.ts)                                                        | Suite; receipt-only fixture install proven. Full execution-policy wiring still needs F1-T5; unit gates are not proof of job-time consent/pin enforcement. P3-T2/T3.                                                         |
| Python sidecar handshake, job events and inter-process VRAM ownership                      | [sidecar integration](../packages/cli/sidecar_integration_test.ts), [VRAM wiring](../packages/gen/vramlease_test.ts), [lease protocol](../packages/core/vramlease_test.ts)                                                                                         | Suite + follow-up + doctor handshake. Keep contract v1. Dedicated two-process opt-in integration was not run.                                                                                                               |
| Journaled GUI mutations, undo/redo, schema migrations and future-version refusal           | [journal](../packages/core/journal_test.ts), [receipts](../packages/core/receipts_test.ts), [schema migration](../packages/schema/migrate_test.ts)                                                                                                                 | Suite covers normal paths. Crash/concurrency and actual asset-history gaps below must be repaired before conversion. P1-T2/T3.                                                                                              |
| CLI twins, honest terminal errors, query JSON versus NDJSON job streams                    | [parity](../apps/studio/parity_test.ts), [CLI](../packages/cli/mod_test.ts), [log sink](../packages/cli/log_sink_test.ts), [event schema](../packages/schema/jobs.ts), [observed error](baseline/error.ndjson)                                                     | Suite + follow-up. Error shape is `{t,jobId,at,code,message,retryable}`; jobs have one terminal outcome, queries return documents. Keep valued-flag and stderr/cancel gaps in F1.                                           |
| Tauri editor tabs, stage gating, locale/theme/focus/logs, viewport disposal                | [stage tests](../apps/studio/stages_test.ts), [locale extraction](../apps/studio/i18n_extract_test.ts), [logs](../apps/studio/log_test.ts), [disposal](../apps/studio/dispose_test.ts)                                                                             | Source tests, TS/web build and Rust check pass. No fresh installed UI, native accessibility, IME, drag/drop, cancel or soak proof. P4-T1/T2/T4/T5; preserve working UI while improving it.                                  |

## The eight laws remain release requirements

| Law                                                                 | Evidence and boundary                                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest/CLI is the interface                                       | CLI twins and schema tests above; GUI filesystem scans remain a gap for F1-T4.                                                                                                     |
| Preview/export parity; retarget once in core                        | Animation preview/bake integration and pack/export byte comparisons; the inspector is not pixel truth.                                                                             |
| Cache hashes inputs, includes renderer identity, binds immutable ID | Cache/provenance tests. Driver identity is missing from the legacy signature; record it separately. Snapshot output hashes below are comparison/backup evidence, never cache keys. |
| Canonical glTF at the importer border                               | Importer double-import, orientation, skin and compression tests. Keep the importer in the eventual installed bundle.                                                               |
| AI backends and animation packs are catalog data                    | Registry/pack tests; exact job-time pins and policy gates remain F1-T5 work.                                                                                                       |
| BakeManifest canonical; exporters pure; AOV rect identity           | Pack integration and exporter projection tests; saved manifest and cold/warm page hashes.                                                                                          |
| GUI edits are reversible core patches                               | Normal journal tests pass. Filesystem history, crash recovery and concurrent writers are not yet safe.                                                                             |
| Identical same-machine inputs produce identical bytes               | Render double-run canary, importer double imports, pack/export integration and independent control replay. Do not assert cross-device/driver pixel equality.                       |

## Preserved platform targets

This is the **application/renderer** matrix. Native/emulated execution and CPU architecture are
separate claims. A CI workflow declaration is source evidence, not a freshly observed CI run. All
unverified cells remain blocking qualification gates in F2/F7; F0 does not drop those targets.

| Target              | Existing route / intent                                                           | Fresh F0 evidence                                                                    | Still open                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Windows x64         | Native Deno CLI, Vulkan/DX12 renderer, Tauri/WebView2; primary validation target  | Native x64 Vulkan render/control, suite, sidecar handshake, web build and Rust check | DX12, diagnostic failure, signed/installed Tauri/CLI artifact, live UI/AT                                        |
| Windows ARM64       | Retained target; legacy Deno CLI uses x64 emulation                               | No matching hardware run                                                             | Emulation performance/GPU/sidecar behavior; native Node/addon/Tauri artifact and dependencies independently      |
| macOS Apple Silicon | Retained native arm64 CLI/Metal/Tauri target; release workflow has arm64 CLI      | No matching hardware run; macOS CI configuration inspected                           | Metal workload, Python wheels, app-owned runtime/addon, signing/notarization and accessibility                   |
| macOS Intel         | Retained x64 CLI/Metal/Tauri target; workflow runs its CLI under Rosetta on arm64 | No native Intel or Rosetta run here                                                  | Native Intel hardware versus Rosetta evidence must be recorded separately; same packaging/GPU gates              |
| Linux x64           | CLI/render retained; desktop stays documented tier 2; CI declares lavapipe        | No Linux run here                                                                    | Hardware Vulkan and separate software lane; installed runtime/importer; WebKitGTK desktop smoke before promotion |

The current desktop config builds **NSIS only**. A Rust check does not prove ARM64 installers, macOS
bundles or Linux desktop delivery. Existing CLI release targets omit Windows ARM64; the retained
target needs an actual qualified replacement route. See
[current support intent](../docs/platform-support.md), [CI](../.github/workflows/ci.yml) and
[release source](../.github/workflows/release.yml).

Model availability is a different matrix:

| Workload                                                | Current adapter route                                       | Fresh F0 evidence / limitation                                                                                                                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fixture generation / Track A fit / existing mesh render | Synthetic CPU Python adapter; TypeScript fit; WebGPU render | Windows x64 control passes. No AI inference or likeness claim; other OSes unverified here.                                                                                     |
| TRELLIS.2 + retexture / UniRig Track B                  | Implemented catalog routes declare Windows/Linux CUDA       | Handshake lists adapters; **no real inference rerun**. Historical Windows measurements are not a fresh/offline/fresh-machine proof. ARM64 and Linux qualification remain open. |
| macOS local generation/auto-rig                         | No qualified Mac route for the current CUDA adapters        | An app/Metal renderer running on Mac would not establish this capability. New Mac profiles remain F3 work.                                                                     |
| New TRELLIS/Pixal3D/Hunyuan runtime profiles            | Research candidates in [models.md](models.md)               | No new installation, terms acceptance, inference, memory or quality qualification in F0.                                                                                       |

## Reproduce and preserve the control

Use the pinned legacy checkout with Deno **2.9.2**, the existing locked dependencies and prepared
Python/uv environment. Do not run the destructive lean-release helper in this checkout. From the
repository root in PowerShell:

```powershell
$env:DENO_WEBGPU_BACKEND = 'vulkan'
$env:SPRITEBOOK_REQUIRE_GPU = '1'
New-Item -ItemType Directory -Force .render-bench/f0 | Out-Null
deno run --allow-read --allow-write --allow-env --allow-ffi --allow-net=127.0.0.1 --allow-run tools/proofs/migration-baseline.ts .render-bench/f0/my-control
```

Use `metal` on Mac; record native architecture or emulation. The script refuses an existing output
directory, including a failed run. It installs only the weightless fixture receipt into its own
model root, generates seed 7 at 1.7 m, picks r1, fits/accepts the bundled textured 65-joint body,
enables `idle-loop:4,walk-loop:4,punch-jab:4`, and records a pixel look with 8 directions, 100x128
cells, 32 px/m and padding 16. Supersampling uses the existing journaled `setLook` capability
because the CLI has no supersample flag. Each verb otherwise launches the actual CLI in its own
process, as Tauri currently does.

Each S value uses an empty application frame cache, then an unchanged warm bake. The proof asserts
96 frames, 0%/100% cache hits, stable bake identity and all-five-page hash equality, then exports
Godot/Aseprite/TexturePacker/strips. `commands.json` retains args/stdout/stderr; `report.json` holds
toolchain/input/page hashes; six manifest snapshots keep cold metrics before warm writes replace
them. Existing render/material/attachment/asymmetry tests complement this workload rather than
duplicating those fixtures in another harness.

Cold includes CLI startup and adapter/pipeline initialization. It does not flush OS/driver caches or
Python package caches. These are single samples of a deliberately small workload, not the
100-character/overnight budget or a model benchmark. The evidence JSON contains the quiet replay
timings and the first run separately. Only the replay should be used as the F2 timing reference;
capture old/new measurements again together before enforcing the proposed 10% budget.

The synthetic Track A fit reports **42 stray joints and 2,091 unprojected vertices**. Acceptance
here exercises the explicit receipt/animation path; it does not certify anatomical quality or
source-image likeness. The saved fit report and warning stream must stay visible. This is a
mechanical control, alongside the better-proportioned fixtures in the existing fit/retarget tests.

To reproduce the suite with its missing prerequisite supplied, use the control's isolated receipt:

```powershell
$env:SPRITEBOOK_MODELS_DIR = (Resolve-Path .render-bench/f0/my-control/models).Path
deno task test
```

The fresh F0 follow-up instead ran just `apps/studio/parity_test.ts`,
`packages/cli/anim_preview_test.ts` and `packages/gen/vramlease_test.ts` with the task's normal
permissions. No image suite was automatically retried. For desktop compile checks:

```powershell
deno task --cwd apps/studio check:web
deno task --cwd apps/studio build:web
cargo check --offline --locked --manifest-path apps/studio/src-tauri/Cargo.toml
```

The full generated controls, original workspace histories, canonical bytes, bakes, caches and
exports remain under `.render-bench/f0/`. The measured JSON pins a ZIP backup and its SHA-256. These
large local artifacts are intentionally ignored; the checked-in character/BakeManifest/error samples
and measurements are portable records, not a complete binary backup. A fresh clone must replay the
pinned control on its own machine. Before F1/F2/F4 workspace testing, verify the backup hash,
copy/extract into a **new disposable directory**, and pass only that copy to the experiment. Never
mutate the sealed control or point a conversion at a user's original workspace; preserve any real
workspaces/exports separately before introducing them to migration tests.

## Known defects and unverified gates

Repository-wide formatting/lint debt is also open: the evidence JSON lists the eight unchanged
formatting failures and unused test import. Resolve those separately before declaring CI green; F0
does not include an unrelated formatting sweep or test edit.

| Finding                                                                                                    | Status / next owner                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pick A, pick B, undo restores A metadata but leaves B's canonical GLB                                      | Reproduced before F0; [details](architecture-review.md#safety-work-before-migration). F1-T2/T1 must restore actual historical bytes. Never record this as desired compatibility.                                                                               |
| Journal/cursor/manifest writes lack a shared recoverable transaction; concurrent writers can race          | Source-reviewed; no injected-crash qualification yet. F1-T2 is the next task.                                                                                                                                                                                  |
| Character-local editor drafts, job stderr/cancellation and GUI current-bake reads                          | Reviewed gaps in F1-T3/T4; compile/source tests do not close live ownership/recovery checks.                                                                                                                                                                   |
| Fixture-dependent tests assume a machine-global install                                                    | Six observed failures disappear with an isolated receipt. Keep the prerequisite visible; consider self-contained setup with F1-T5/tooling work, not a production-code workaround in F0.                                                                        |
| `doctor` clear probe fails although rendering succeeds                                                     | Fresh observed exit 1, with a successful sidecar handshake. Tests check diagnostic honesty, not that hardware always passes. Investigate validation in F2-T1 before relying on doctor for runtime qualification.                                               |
| One-process gen -> fit -> bake returned `renderer setup validation error: Buffer with '' label is invalid` | Observed in the initial in-process experiment. A separate CLI process rendered that workspace. Root cause unproven; process-per-verb control passes. Keep this as a worker-lifetime/validation gate for F2-T1; do not silently claim persistent-worker safety. |
| Legacy renderer signature omits driver identity                                                            | Record driver 610.88 alongside the signature. F4-T3 needs a new renderer/cache namespace; old cache hits cannot prove Node output.                                                                                                                             |
| Full pin/receipt/policy enforcement and declared model provisioning                                        | Open F1-T5/F4-T4; no real-model fresh-machine/offline proof in F0.                                                                                                                                                                                             |
| Other hardware, installed artifacts, actual engine consumers, UI/AT, roster/soak                           | Explicitly unverified above. F2/F7 release gates remain open; new-model qualification belongs to F3.                                                                                                                                                           |

**F0 exit:** contracts, fixtures, reproducible commands, Windows observations and open platform
gates are recorded. Proceed to **F1-T2: one recoverable writer**; no runtime cutover or new model
adoption has occurred.
