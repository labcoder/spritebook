# Architecture docs — agent guidance

- `architecture.md` states the laws; `packages/schema` defines persisted and wire contracts.
  `data-models.ts` indexes those definitions. Resolve documentation/code disagreements in the same
  change; keep type shapes in the schema package.
- Invariants here are load-bearing (parity, input hashing, manifest-only interface, glTF border,
  retarget-once). Do not weaken one to ship a feature; escalate to a decision entry instead.
- Every entity ID rule matters: `characterId` is an immutable slug; `displayName` is mutable
  metadata. Cache keys, paths, and CLI targets bind to the id, never the name.
