# F1 completion record

**2026-10-19: F1 is complete on `main`. F2 is next.** Tauri, React, TypeScript and the existing
repository remain the approved direction. Deno still runs the product; this milestone makes the
existing state safe before the runtime experiment and cutover.

## What changed

| Task  | Implemented behavior                                                                                                                                          | Evidence                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1-T2 | One inter-process writer, separate job/read locks, unique staging and a recoverable transaction across assets, journal, cursor and manifest                   | [Persistence tests](../packages/core/persistence_test.ts), [protocol](../docs/architecture/workspace-persistence.md)                                                                   |
| F1-T1 | Hash-addressed canonical GLB revisions; actual byte restoration through pick, rig and identity undo/redo; staged promotion                                    | [Asset/crash checks](../packages/core/persistence_test.ts), [bake after undo](../packages/cli/bake_workspace_test.ts)                                                                  |
| F1-T3 | Character/stage/revision ownership, stale-response rejection, cancellation of owned descendants, separate raw stderr and recovered-state refresh              | [Desktop proof](../tools/proofs/editor-ownership.ts), [real descendant test](../apps/studio/src-tauri/src/jobs.rs), [sidecar death/retry](../packages/cli/sidecar_integration_test.ts) |
| F1-T4 | Core workspace/roster/current-bake queries; `lastBakeId` governs review, thumbnail and workspace export; missing/repeated values refuse early                 | [Selection/undo query test](../packages/core/queries_test.ts), [flag tests](../packages/cli/flagvalues_test.ts), [GUI/CLI parity](../apps/studio/parity_test.ts)                       |
| F1-T5 | Exact project model/pack pins, receipt byte checks, declared-consent fingerprints, current platform/territory checks and configuration-based memory admission | [Execution tests](../packages/registry/execution_test.ts), [pack refusal before GPU work](../packages/pack/pins_test.ts), [policy](../docs/architecture/execution-policy.md)           |

Final review also reproduced and fixed cloning over a committed creation intent, accepting a clone
of corrupt canonical bytes, and creating an empty undo entry on an identical fit. Clone checks
resolved containment and consistent lock ordering. Recipe replay preserves the recorded backend
version even when a newer version is installed. These are covered by
[clone regressions](../packages/core/roster_test.ts) and the existing fit and execution suites.

Retexturing produces a generation result; picking that result uses the same revision transaction as
every other pick. Embedded textures travel with the GLB. No historic AI output is regenerated to
implement undo. Character/BakeManifest schema 3 and the sidecar protocol remain unchanged.

## Fresh verification

Windows x64, RTX 3090/Vulkan, driver 610.88 and Deno 2.9.2, using the
[F0 machine/control inventory](baseline/windows-x64-vulkan.json). The isolated test model root
contains the weightless fixture generator; no neural model download or fresh inference calibration
was performed.

- Full standard test task with GPU required: **839 passed, 44 steps, zero failures, five ignored**.
- Studio TypeScript check and production web build pass. Scoped lint and format checks pass.
- Locked Rust check and tests pass. The descendant test creates a real parent/grandchild and proves
  cancel, close/cleanup and retry; its separately invoked fixture is intentionally ignored as a
  standalone test.
- In the actual Tauri/WebView2 shell, a real generation job is canceled without changing accepted
  results, then retry appends exactly one result. Raw stderr stays separate. Delayed-response checks
  exercise character switching, isolated drafts, manifest revision changes and retry.
- Existing GPU render/style/parity suites pass without golden changes. The F0 control archive is
  retained unchanged; F1 tests use disposable workspaces.

The five ignored lanes require explicit real-backend/engine setups: neural generation/rigging,
Aseprite, Godot, Phaser and Unity. They are not counted as passes. The initial full run exposed a
Windows test permission mismatch between `Deno.execPath()` and the permitted `deno` launcher; the
crash workers now use that launcher and pass under the standard task permissions.

Reproduce the main checks from the repository root in PowerShell:

```powershell
# Use an isolated model root; install fixture-gen there once, or verify its existing receipt.
$env:SPRITEBOOK_MODELS_DIR = Join-Path (Get-Location) '.render-bench/f1/models'
deno run -A packages/cli/mod.ts models install fixture-gen --json
$env:SPRITEBOOK_REQUIRE_GPU = '1'
deno task test
deno task --cwd apps/studio check:web
cargo test --locked --manifest-path apps/studio/src-tauri/Cargo.toml
```

The desktop proof's header records its CDP command and required permissions. For the web build, run
`node node_modules/vite/bin/vite.js build` in `apps/studio` (Node 24.18.1 here). Raw logs remain
local under `.render-bench/f1/`; source proofs and this result summary are tracked.

## Boundaries carried forward

Process death is covered. Directory-entry durability on sudden power loss is not promised. Asset
revisions are retained without garbage collection. Missing pre-F1 transformed bytes cannot be
invented; unsafe history restoration refuses. Late cancellation may observe a complete committed
transaction, followed by a fresh core read; it never accepts a half-published asset.

Mac, Windows ARM64 and Linux hardware/installed artifacts were not qualified here. Unix process
groups still need platform execution evidence; abrupt Unix shell death is not claimed to have
Windows job-object semantics. Historical memory profiles are admission floors with headroom, not new
model/platform or licensing qualification. The reserved project renderer pin remains F4 work.

The development server exposed two existing tooling problems: Deno/Vite optimization stalled, and
the Node dev watcher crashed on a locked Rust target executable. Desktop verification used Node with
a temporary `src-tauri/target` watch exclusion. This workaround is not a shipped-tooling fix; F4-T4
must close it. The F0 doctor clear-probe defect and existing repo-wide lint/format debt remain
recorded in the baseline. No release, installer, live assistive-technology or soak claim is added.
