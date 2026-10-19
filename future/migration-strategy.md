# Repository strategy: migrate this repository

Decision approved: **2026-10-18, D-042**. Incremental migration within this repository is the
selected strategy. The [roadmap](roadmap.md) now provides the ordered implementation plan; no
runtime code or installed dependencies have changed in this documentation session.

## Approved direction

**Keep this repository and migrate it incrementally. Do not start a new repository or a parallel
replacement application.** Keep Tauri and the TypeScript product core as the maintainer has decided.
Recommend Node LTS for the replacement runtime and qualify Node/Dawn first for headless rendering.
Preserve the existing React UI inside Tauri.

This is the best fit for the evidence: the product architecture and substantial working behavior are
reusable; the runtime, data-safety and delivery boundaries need repair. A fresh repository does not
remove those problems. It adds the work of reconstructing the same application before we can prove
that the replacement is better.

The repository decision and the exact GPU implementation are different decisions. We can commit to
working here without pretending Node/Dawn has already passed its hardware/packaging gates. If it
fails a specific requirement, evaluate a narrow native render worker while keeping the product core
in TypeScript. That is not a reason to replace the repository or desktop toolkit.

## Why the investigation supports this path

1. **The selected stack is already here.** The core is TypeScript and the desktop is Tauri/React. We
   are replacing their Deno dependency, not adopting a different product language or UI stack.
   [Workspace](../deno.json), [desktop](../apps/studio/package.json),
   [shell](../apps/studio/src-tauri/src/main.rs).
2. **The valuable behavior is implemented.** Canonical glTF import, animation retargeting and
   preview clips, pixel styling, atlas/AOV layout, game exporters, catalog installation and CLI
   twins are real code. Rebuilding or selectively copying them requires the same semantic checks
   with more integration work. [Architecture review](architecture-review.md).
3. **There are useful replacement seams.** Schema packages, file-based render inputs/outputs,
   versioned sidecar messages and manifest-driven jobs let us replace runtime-specific pieces within
   the current package structure. A new repo is not needed to establish these boundaries.
   [Render entry](../packages/render/mod.ts), [sidecar contract](../packages/schema/sidecar.ts).
4. **Tests and history are migration assets.** Fixtures, structural renderer tests, export smokes,
   parity tests and recorded failure investigations specify behavior that a new implementation could
   otherwise lose. Their harness still needs a Deno port; starting fresh does not avoid it.
   [CI](../.github/workflows/ci.yml), [CLI twins](../apps/studio/parity_test.ts),
   [recorded audit](../docs/internal/proofs/adversarial-audit-2026-08-16.md).
5. **The serious defects are concrete.** Artifact undo, journal transactions, cross-process writes,
   stale character state and installed-app execution have identifiable causes. Fix them at their
   shared ownership boundaries. Copying code can carry the defects forward; rewriting everything
   discards the evidence needed to detect them.
   [Safety findings](architecture-review.md#safety-work-before-migration).

## Alternatives considered

| Approach                                                     | Assessment                                                                                                                                               | Verdict                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Incremental migration in this repository**                 | Retains packages, tests, Git history and a runnable reference while individual runtime/process boundaries change                                         | **Approved**                                                   |
| **New repository, copy selected code**                       | Requires rebuilding workspace/tooling/release integration and tracking changes between two homes; copied behavior still needs migration and safety fixes | Reject for this migration; no demonstrated technical benefit   |
| **New repository, rewrite from scratch**                     | Recreates importer, retargeting, styling, contracts, UI and export behavior despite keeping the same language and desktop toolkit                        | Reject; highest unnecessary regression and delivery risk       |
| **A whole replacement app under `next/` in this repository** | Keeps history but still creates two engines/editors and a large final cutover                                                                            | Reject as the default; a bounded renderer experiment is enough |

A branch or temporary worktree of this repository is an isolation mechanism, not a new product
repository. Use one when implementation needs it. Do not duplicate the entire package tree or
maintain two long-lived versions of product behavior to make the migration look cleaner.

Git history can be preserved when transferring a repository. The recommendation does not depend on
claiming otherwise: moving the same code/history elsewhere brings the same Deno and safety work with
it, while a fresh implementation adds reconstruction risk. Neither provides a technical advantage
over migrating here.

A future ownership/licensing split or independently maintained product could justify another
repository. Neither is established by the investigation or the current stack decisions. Repository
organization can be reconsidered later without making it a prerequisite for replacing Deno.

## What staying here commits us to

Preserve immutable character IDs, accepted assets, manifest semantics, animation behavior and export
contracts. Retain tests that describe correct behavior and add regression checks for known defects;
do not preserve a bug merely because the old implementation does it. Adapt runtime-specific code and
tooling where needed, rather than treating every existing file as untouchable.

Keep the old Deno implementation usable as a temporary reference, then retire its execution, tooling
and release requirements once replacements pass. The intended result is one supported TypeScript
core, one Tauri app and one production rendering path, not permanent dual runtimes.

Workspace conversion still needs preserved originals, artifact restoration, crash/concurrency checks
and rollback tests. New rendering software needs a fresh renderer signature/cache namespace. GPU and
inference support still require exact platform/runtime measurements. These are obligations of any
repository strategy, not reasons to start over.

## Accepted decision and execution plan

The maintainer approved incremental migration in this repository. D-041 fixes the Tauri/TypeScript/
Deno-exit boundaries; D-042 records the repository decision. No further repository choice is needed.

Follow the [migration roadmap](roadmap.md): **F0 baseline, F1 safety, F2 Node/Dawn qualification, F4
core/toolchain migration, F7 installed release**. New model integrations, the larger editor redesign
and expanded scale work follow through F3/F5/F6. Existing generation/rigging and sprite behavior
remain protected during the migration.

The implementation plan uses supported Node LTS and qualifies Node/Dawn first. Exact native/runtime
pins, binary licensing, hardware support and output parity still require evidence before shipping. A
narrow render worker is a contingency for a documented failure, not permission to replace the
TypeScript product core. Each implementation change should reference its task ID, preserve the
applicable contracts and include its meaningful regression checks.
