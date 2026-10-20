# Hugging Face and local model management

Updated **2026-10-19** for the implemented F4 model setup and Pixal3D work. Remaining F3
recommendations are marked below. The maintainer has confirmed Tauri, TypeScript core/CLI and
replacing Deno; see [technology decisions](technology-options.md). Model provisioning remains
independent of those settled choices. Findings below distinguish the actual repository integration
from unverified interpretations of “Hugging Face Desktop”.

The [in-place migration roadmap](roadmap.md) preserves existing provisioning and inference through
F4/F7; expanded Hub/runtime provisioning is later F3 work. HF recommendations below do not block the
Deno exit except for minimum fixes required by current workflows and clean-install release gates.

## Recommendation

Keep Hugging Face **as one source of model artifacts and user access grants**. Keep SpriteBook's
catalog, installed receipts, and project pins as the product contract. Do not require a separate
model-manager app, a Space, or remote inference. Replace hidden inference-time downloads and warm
cache assumptions with explicit provisioning, then prove the complete job works offline.

## What “Hugging Face Desktop” means in this repository

There is no named HF Desktop dependency in the inspected source, manifests, or docs. This memo
therefore evaluates the actual Hub integration. If the phrase refers to an external app installed
outside this repo, its identity remains unresolved and no keep/remove verdict is claimed for it.

| Term                                | What it does                                                                                                                                                                                            | Current use / proposed boundary                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hub**                             | Stores model repositories and versioned artifacts. [Download documentation](https://huggingface.co/docs/hub/en/models-downloading)                                                                      | Keep as a supported source. A hosted model is neither proof of safe code nor a license approval.                                                                                                                                             |
| **`huggingface_hub` / `hf` CLI**    | Client library and terminal authentication/download/cache tools; the current CLI is `hf`. [Official CLI](https://huggingface.co/docs/huggingface_hub/en/guides/cli)                                     | Keep inside provisioned Python environments where needed; support `hf auth login` as a user fallback. No new desktop application prerequisite. Existing `huggingface-cli login` guidance needs version-aware updating during implementation. |
| **Local Hub cache**                 | Shared version-aware cache, normally under the user's HF cache root. Windows without symlinks may duplicate files. [Cache behavior](https://huggingface.co/docs/huggingface_hub/en/guides/manage-cache) | Treat as an import source or optimization, not an undeclared project dependency. Never delete shared cache data when uninstalling a SpriteBook model.                                                                                        |
| **Spaces**                          | Hosted application/demo execution. [Spaces overview](https://huggingface.co/docs/hub/en/spaces-overview)                                                                                                | No production dependency found. Useful for evaluation, not a durable local/offline execution contract. A downloadable Space is not automatically a reviewed adapter.                                                                         |
| **Inference Providers / Endpoints** | Remote inference services, separate from downloading weights. [Providers](https://huggingface.co/docs/inference-providers/index)                                                                        | No current dependency found. If offered later, make it a separately chosen backend with upload, cost, credential, failure, and provenance behavior. Never use it as a silent Mac fallback.                                                   |
| **SpriteBook model manager**        | Catalog, installed receipts, project pins, CLI install/verify/remove                                                                                                                                    | Keep product ownership here. It is a part of SpriteBook, not a replacement for an HF account or upstream access approval.                                                                                                                    |

### Current strengths and specific gaps

The [installer](../packages/registry/install.ts) stages files, checks byte counts and SHA-256, then
writes receipts. It also accepts local files via `--from`; this is already the right seam for
air-gapped installation or reusing HF downloads. Its downloader now reads `HF_TOKEN`,
`HF_TOKEN_PATH` and the user's Hub token file, honors disabled implicit authentication and strips
credentials on CDN redirects. Tokens are never recorded in model receipts or logs.

The [UniRig adapter](../sidecar/spritebook_sidecar/adapters/unirig.py) routes checkpoints to
absolute installed paths, disables HF network access and telemetry for its stage processes, and uses
the owned architecture description with the unchanged MIT checkpoints. The new catalog version omits
the restricted historical OPT config. Every declared file is verified before execution, so an
incomplete receipt refuses before loading. Existing accepted assets can still be used without
re-running the model. [Execution policy and verification](state-safety.md).

The [TRELLIS.2 adapter](../sidecar/spritebook_sidecar/adapters/trellis2.py) loads from the model
directory with a complete decoder/DINOv3 closure. The
[Pixal3D adapter](../sidecar/spritebook_sidecar/adapters/pixal3d.py) also declares its NAF
checkpoint and uses a separate frozen runtime. DINOv3 access remains a per-user installation gate;
inference uses verified local files with no Hub fallback. Both paths avoid BRIA construction and
remote model code. Pixal's explicit manual camera avoids an implicit MoGe download. Pinned source
archives, wheel locks, native checks and readiness receipts describe the runtime separately from
weight receipts. The worker loads only the owned SpriteBook package into its isolated interpreter;
base-environment dependencies must not leak into it. Owned wheel cache keys track Python/JSON
sources so a same-version app update refreshes adapter code.

### Proposed model-management contract

1. **Provision every runtime input.** Record full upstream commit IDs, expected files, hashes,
   adapter code revision, wheel/environment locks, and all conditioner/tokenizer/config inputs. HF
   download APIs default to `main` unless a revision is specified and support full-commit revisions
   plus selective downloads; use those facilities without making a floating branch a project pin.
   [Hub downloads](https://huggingface.co/docs/huggingface_hub/en/guides/download).
2. **Separate permission from installation.** Explain the upstream gate, open its official page,
   authenticate, then explicitly retry provisioning. Gates are per user and may require manual
   approval. We can automate the authenticated download after approval; we cannot grant someone
   access on the model owner's behalf.
   [Gated model documentation](https://huggingface.co/docs/hub/en/models-gated).
3. **Keep credentials outside project artifacts and logs.** Prefer a bounded provisioning helper
   using the official client over a second ad hoc HF auth implementation. Read a supported local
   credential or use an OS credential store for app-owned tokens. Use the least read scope needed;
   do not pass tokens through the webview, command arguments, manifests, URLs, or raw NDJSON. HF
   supports token/cache locations through its environment settings, but a local token file is not
   evidence of OS-encrypted storage.
   [Environment reference](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables).
4. **Make ordinary inference offline.** Once installed, use explicit local paths and
   `local_files_only` where supported, plus `HF_HUB_OFFLINE=1`; configure telemetry suppression for
   HF clients. Those flags affect the HF library, not arbitrary adapter sockets. Prove the full job
   succeeds with outbound access blocked and an empty unrelated HF cache.
   [Offline behavior](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables).
5. **Make interrupted installation recoverable.** Preserve staged writes and hash/byte validation;
   add disk-space preflight, explicit progress, retry/resume for large downloads where supported,
   and a clear no-receipt recovery path. Retry a transfer without weakening final verification.
6. **Own installations, respect shared caches.** Keep the current SpriteBook receipt directory as
   authority. Import verified bytes from a user-selected cache/snapshot instead of introducing a new
   global cache system first. Report space before copying multi-GB files, and make a later
   shared-store optimization justify its cross-platform link/locking/eviction complexity.
7. **Audit executable trust separately from artifact integrity.** SHA-256 confirms the selected
   bytes; it does not make a pickle, remote Python module, native extension, or source checkout
   harmless. Prefer non-executable weight formats when available; reject arbitrary remote code by
   default and review any required exception at a pinned revision. Transformers documents that
   custom Hub models need `trust_remote_code=True`.
   [Custom model loading](https://huggingface.co/docs/transformers/en/custom_models).
8. **Enforce licenses and attribution per dependency.** Track the code, primary weights,
   conditioner, preprocessing model, extensions, and required notices separately. Keep existing
   territorial and pre-install acceptance gates. New restrictions need explicit catalog policy; an
   HF badge or authenticated download does not supersede
   [dependency policy](../docs/dependencies.md).

## Proposed acceptance gate

Allow 2–3 engineering days for a bounded provisioning slice, not a new general model platform.
Exercise the existing catalog-ID install/verify/remove verbs first; add capabilities only where
required for the chosen models. A new verb or receipt field is a proposal requiring normal schema,
compatibility, and decision review, not something accepted by this memo.

The slice passes only with all of the following evidence:

- Fresh account and unrelated HF cache: install an ungated model; show a gated authorization failure
  before a long model load; grant access through the official model page and retry.
- Record exact artifact and execution-environment revisions; verify hashes and receipts; reject a
  truncated, corrupt, or interrupted install without presenting it as ready.
- Import the same verified files through existing `--from` delivery; run successfully with outbound
  network blocked and no dependence on a developer's shared HF cache.
- Show space requirements, actionable retry, and readable acceptance/attribution records; prove
  uninstall removes only SpriteBook-owned files and leaves the shared HF cache untouched.
- Confirm tokens do not appear in project artifacts, command arguments, UI bridges, URLs, or raw
  NDJSON logs. Credentials remain under the chosen local credential policy.
- Produce canonical GLB plus provenance that imports and renders successfully; a downloaded weight
  directory alone is insufficient to call the backend ready.

If the slice fails, repair the missing files, authentication path, or environment contract. Do not
silently route a Mac user's inputs to a cloud service or assume that replacing the Hub resolves CUDA
compatibility or third-party model licensing.

## Limits

No download, authentication, credential inspection, model run, cache deletion, or offline network
experiment was performed. This is a source and documentation review. A distinct external desktop
product meant by “Hugging Face Desktop” remains unidentified; no keep/remove judgment is claimed for
it. Hub/client behavior and dependency licenses must be rechecked at implementation time.

## Setup and ownership requirements

Separate runtime setup from weight installation. Show per-file/byte progress, stalls, retry/repair
steps, reused weights, incremental disk cost and dependent model variants. Keep hash-verified
receipts as the trust anchor. Failed setup or cancellation retains the last accepted asset;
cancellation reaches the owned process tree, and the UI explains when unloaded weights must reload.
