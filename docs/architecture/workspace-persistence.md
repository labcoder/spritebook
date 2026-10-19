# Workspace persistence

F1-T2 moves character creation, receipts, rename and undo/redo through
[`packages/core/persistence.ts`](../../packages/core/persistence.ts). CLI history operations call
core; they do not implement their own writer. CharacterManifest and ManifestPatch schemas remain
unchanged. D-043 records this decision.

The persistent `<manifest>.lock` uses an exclusive OS file lock. Ownership covers recovery, reading,
patch/inverse construction and publication. Closing the handle or killing its process releases
ownership. Lock files are never unlinked or stolen based on elapsed time. Nested core operations
reuse ownership in their asynchronous call context; separate jobs do not share it.

A mutation validates the next state, writes a uniquely staged and file-synced version-1
`<manifest>.pending.json`, then atomically renames it into place. That intent is the commit point.
It contains the next manifest, complete retained journal and cursor. Materialization atomically
replaces the journal, cursor and manifest, then removes the pending record. A core reader acquires
the same lock and finishes any pending transaction before exposing state. Recovery is idempotent;
malformed or unsupported pending records refuse rather than overwriting the accepted document.

Before the intent lands, a failed operation leaves the old state. After it lands, the next reader
finishes the new state even if the writer died before acknowledgement. This is a process-crash
guarantee. File syncing helps persistence, but cross-platform directory-entry durability during
sudden power loss is not promised. Legacy direct file readers are not transaction-aware; migrate the
remaining GUI reads through core in F1-T4. Do not run old and new writers concurrently.

F1-T1 extends this same commit point to canonical asset revisions and materialization. Until that
step lands, metadata recovery does not repair the old asset-undo defect. Never test migration on the
sealed F0 controls or original user workspaces.

Validation uses independent child processes: concurrent appenders retain both histories and their
inverses; abrupt exit before intent and after each rename boundary recovers a coherent old/new
state. The normal test/coverage tasks grant Deno subprocess permission for these checks. No image
goldens or retry loops are involved. Fresh execution so far is native Windows x64; other platforms
remain qualification work.
