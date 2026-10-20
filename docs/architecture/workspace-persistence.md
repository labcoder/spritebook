# Workspace persistence

Character creation, receipts, rename and undo/redo go through
[`packages/core/persistence.ts`](../../packages/core/persistence.ts). CLI history operations call
core; they do not implement their own writer. F1 preserved the existing manifest and patch schemas;
D-043 records the persistence decision. Current document versions live in
[`packages/schema/migrate.ts`](../../packages/schema/migrate.ts).

The persistent `<manifest>.lock` uses an exclusive OS file lock. Ownership covers recovery, reading,
patch/inverse construction and publication. Closing the handle or killing its process releases
ownership. Lock files are never unlinked or stolen based on elapsed time. Nested core operations
reuse ownership in their asynchronous call context; separate jobs do not share it.

F4's Node implementation acquires the same kernel lock through the app-owned `spritebook-lock`
helper (`LockFileEx` on Windows, `flock` on Unix). A dedicated stdin pipe holds its lifetime; normal
release or Node process death closes the pipe and drops the native handle. Acquisition order,
reentrancy, transactions and recovery remain in TypeScript. The compiled helper ships with core;
development builds compile it with Rust. The persistent lock file is still never deleted.

A mutation validates the next state, writes a uniquely staged and file-synced version-1
`<manifest>.pending.json`, then atomically renames it into place. That intent is the commit point.
It contains the next manifest, complete retained journal and cursor. Materialization atomically
replaces the journal, cursor and manifest, then removes the pending record. A core reader acquires
the same lock and finishes any pending transaction before exposing state. Recovery is idempotent;
malformed or unsupported pending records refuse rather than overwriting the accepted document.

Before the intent lands, a failed operation leaves the old state. After it lands, the next reader
finishes the new state even if the writer died before acknowledgement. This is a process-crash
guarantee. File syncing helps persistence, but cross-platform directory-entry durability during
sudden power loss is not promised. Studio's workspace/bake reads now use the core projections below.
Legacy direct file readers are not transaction-aware. Do not run old and new writers concurrently.

Canonical GLB revisions, including embedded textures, live under `canonical/revisions/<sha256>.glb`.
Before intent, the writer verifies and retains the previous selected bytes and the staged new bytes.
The pending record's optional `assetHash` must agree with its manifest; recovery materializes that
complete revision before replacing metadata. Undo/redo selects the retained revision, and undoing a
first pick removes its materialized canonical file. Rig and identity jobs submit staged files to the
writer; they never replace accepted canonical bytes before committing their patch.

Existing workspaces retain their schema and layout. Revisions are captured when first edited; legacy
picks can recover from an exact surviving result file. Missing transformed history cannot be
reconstructed honestly, so that undo refuses without changing the selected asset. Corrupt or
mismatched selected/revision bytes refuse too. Revision files are deduplicated by hash and retained;
there is no automatic history garbage collection. Metadata-only fixtures/workspaces without asset
bytes remain readable. Never test migration on the sealed F0 controls or original user workspaces.

Validation uses independent child processes: concurrent appenders retain both histories and their
inverses; abrupt exit before intent and after each rename boundary recovers a coherent old/new
state. The Node checks run the actual child-process fixtures against emitted core modules. No image
goldens or retry loops are involved. Fresh execution so far is native Windows x64; other platforms
remain qualification work.

## Job ownership (F1-T3)

Writers first acquire `<manifest>.job.lock` for the complete read/compute/commit operation, then
`<manifest>.lock` for the short recoverable transaction. Core job generators retain their lease
until completion or iterator cleanup. The CLI also encloses workspace argument resolution in that
lease. Readers take only the short lock and can show the previous accepted revision during
inference. The OS releases both locks when the owning process dies; never delete lock files as a
reset.

The editor keys drafts to a character, scopes jobs to its stage and manifest snapshot, and cancels
on scope disposal. Old callbacks cannot report success into a newer scope. The Tauri shell owns CLI
descendants with a Windows job object (kill on handle close) or a Unix process group. A stdin
startup gate prevents workers from starting before ownership is assigned. Explicit cancellation,
window destruction and normal job cleanup kill the owned tree. Windows descendant cancellation is
exercised by a real parent/grandchild test; macOS/Linux execution remains a platform qualification
gate. Abrupt Unix shell death is not claimed to have Windows kernel job-object cleanup semantics.

Stdout remains the CLI's original query document or NDJSON stream. Stderr has a distinct per-job
channel and diagnostic file; the log drawer displays its lines verbatim with error severity. Failed
rig/fit acceptance is a terminal error even when intermediate output files were retained.

## Read projections (F1-T4)

`listWorkspaces`, `readCurrentBake` and `readBakeArtifact` are core queries exposed through
`workspace`. Artifact selection and byte reads share the short recovery lock. `lastBakeId` is the
only implicit bake selection; its manifest must match the selected id and character. Artifact paths
cannot escape the bake directory. Missing selections return null; corrupt selections fail rather
than choosing a newer directory. The Tauri shell delegates gallery/thumbnail/atlas selection to
these queries. `export --workspace` uses the same selection; explicit `export --bake` is preserved.

## Creation and late termination

A committed creation intent reserves its destination even before character.json is materialized.
Clone checks both files before copying, rejects destinations inside the source (including resolved
aliases), and locks canonical paths in a consistent order. Initialization verifies and retains a
copied canonical asset before publishing its first intent.

An identical rig/fit rerun succeeds with a `rig-unchanged` warning and no undo entry. Other
acceptance failures remain terminal. Cancellation racing an already committed intent may reveal the
complete new state after recovery; it cannot turn that intent into a partial accepted asset. The
editor refreshes recovered state when work terminates, and tab activation reads current state.
