# Architecture docs — agent guidance

- `architecture.md` states the laws; `data-models.ts` is the schema draft that P1-T2 turns into the
  real `packages/schema`. When they disagree with code, that is a bug in one of the three — resolve
  it in the same change.
- Invariants here are load-bearing (parity, input hashing, manifest-only interface, glTF border,
  retarget-once). Do not weaken one to ship a feature; escalate to a decision entry instead.
- Every entity ID rule matters: `characterId` is an immutable slug; `displayName` is mutable
  metadata. Cache keys, paths, and CLI targets bind to the id, never the name.
