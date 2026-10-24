# Technical decisions

This page records current technical exceptions and their boundaries. The architecture guide states
the system laws; source schemas define data. Historical migration research remains in `future/`.
Private plans, timelines and raw experiment output belong in the management workspace.

## Permanent character deletion

Ordinary durable edits remain journaled and reversible. **Delete project** is an explicit,
irreversible operation because keeping an undo copy would retain the generated assets the user asked
to remove.

Core owns the operation and exposes `spritebook delete --workspace <dir> --confirm <character-id>`.
Studio requires a separate confirmation dialog; closing a tab or pressing Delete in the character
index keeps its existing non-destructive meaning.

Deletion acquires the character job and manifest locks, rejects active work and removes only fixed
SpriteBook-owned generated paths. It preserves the original external input, retained original source
copies (including past sources in journal history), unknown user files, external exports and
machine-level models/extensions. It does not recursively erase arbitrary workspace contents or
follow linked targets. Small lock files and the retained source directory can remain.

The manifest is removed last so failed cleanup remains visible and retryable. A failure may already
have removed some generated files; retry means finishing deletion, not rolling it back. Recovery and
ownership tests must protect these boundaries. See
[workspace persistence](architecture/workspace-persistence.md#permanent-character-deletion) and the
[user guide](../user/projects.md#delete-a-project).
