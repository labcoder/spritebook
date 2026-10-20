# SpriteBook's next version

**Start here.** This is a decision set for a substantial remake that preserves SpriteBook's product
vision. Research date: **2026-10-18**. Repository base: `42be3bbebfc783edb42fb64001aa9b2e3d638c98`.

**Confirmed by the maintainer:** keep Tauri as the desktop shell, keep TypeScript as the main
product core and CLI, and replace Deno. These choices are settled for this migration; GPUI, separate
native shells, and a full Rust core are not active tracks. Existing product contracts, dependency
policy and implementation remain in force during the migration.

**Repository strategy approved:** migrate this repository incrementally, preserving its packages,
tests, fixtures and history. See the [accepted strategy](migration-strategy.md) and
[migration roadmap](roadmap.md). The plan targets supported Node LTS and qualifies Node/Dawn first;
exact dependency pins and renderer adoption still require the stated checks. F0 baseline capture is
complete; [the evidence and preservation matrix](baseline.md) records the current Windows control,
known failures and unverified targets. [F1 safety repairs are complete](state-safety.md).
[F2's Windows renderer and installer proof is complete](renderer-qualification.md), with the
additional native platforms deferred to F7 and release notice/prerequisite/signing gates explicit.
**F4 is complete:** main runs the compiled TypeScript core/CLI on Node 24.22.0.
[Windows parity and installed proofs pass](runtime-cutover.md), including the
[existing model provisioning/licensing gate](model-provisioning-gate.md), real offline generation,
retexture, UniRig, sprites and recovery. F7 release and deferred native-platform qualification is
next; no public release is claimed.

## Recommendation in one paragraph

Modernize this repository through small, reversible changes. Preserve the manifest/CLI contracts,
TypeScript sprite/animation/export behavior, and current React UI inside the selected Tauri shell.
Recommend Node LTS for the core and qualify Node/Dawn first to retain the TypeScript GPU host code;
consider a narrow native renderer only if that path fails a documented gate. Keep HF as an artifact
source and qualify model/runtime profiles independently. Starting fresh would require reassembling
the same behavior; moving the existing Git history to another repository would not remove the hard
migration problems either.

## Read in order

| File                                                     | Question it answers                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [Vision and decision brief](vision.md)                   | What product are we remaking, what should the experience become, and which choices need a decision?                          |
| [Repository migration strategy](migration-strategy.md)   | Why is this repository retained, which alternatives were rejected, and what does the approved direction preserve?            |
| [Architecture review](architecture-review.md)            | What actually runs today; what is worth keeping; what safety, CLI, UI, cache and delivery gaps need repair?                  |
| [Deno replacement](runtime-migration.md)                 | What must move, which GPU/runtime paths are credible, and how do we preserve data and output behavior?                       |
| [Model landscape](models.md)                             | Which text/image-to-3D models and implementations deserve trials on Windows, Mac and Linux, under which terms and resources? |
| [Desktop and language decisions](technology-options.md)  | What is settled about Tauri and TypeScript, what still needs validation, and which alternatives are now historical research? |
| [Hugging Face and model management](model-management.md) | What HF integration exists, should we retain it, and how should authentication, caches, pins and offline inference work?     |
| [Migration roadmap](roadmap.md)                          | What is the required execution order, what evidence closes each task, and which model/UX improvements come later?            |
| [F0 preservation and control](baseline.md)               | Which contracts and platform targets must survive, what ran, and how do we replay the legacy control safely?                 |
| [F1 state-safety completion](state-safety.md)            | What changed in state, process ownership, queries and execution policy; what passed and what remains unqualified?            |
| [F2 renderer qualification](renderer-qualification.md)   | Does the actual Node/Dawn pipeline preserve pixels and performance, and which installed/platform gates remain open?          |
| [F4 Node cutover](runtime-cutover.md)                    | What migrated, what passed in the installed Windows app, and what remains open?                                              |
| [F4 model setup gate](model-provisioning-gate.md)        | How are existing models provisioned, which exact terms apply, and what evidence closed the gate?                             |

## Findings that change the decision

- **Runtime migration is warranted, with time to stage it.** Distinguish Deno runtime support from
  Deploy hosting shutdown; see the
  [verified timeline](runtime-migration.md#the-deadline-and-the-actual-dependency).
- **Some old model rejections are implementation-specific.** New native/ComfyUI routes change the
  candidate set; they still require license and full-pipeline hardware validation. Mac generation
  alone does not establish Mac auto-rigging. [Model evidence](models.md).
- **The desktop and core language decision is made.** Keep Tauri and TypeScript; the GPUI and
  separate-native-app investigations are retained as historical context, with no planned UI or
  core-language replacement. [Decision boundaries](technology-options.md).
- **There is no identified HF Desktop app dependency.** Actual usage is Hub artifacts and Python
  client/cache behavior, with a hidden provisioning gap. [HF review](model-management.md).
- **F1 repairs the reproduced state-consistency defects.** Undo now restores canonical bytes;
  transactions recover under one writer; desktop jobs and core reads share clear ownership.
  [Implemented behavior and verification](state-safety.md).

## How this review was done

The source review below is historical. Fresh F0 and F1 execution evidence is recorded in
[the baseline](baseline.md) and [the state-safety completion record](state-safety.md).

Validation for the original research change: Markdown formatting, local link/anchor checks, source
spot-checks, and one isolated CPU-only reproduction through the real CLI implementation. The
historical repo performance/proof logs were read, not rerun. No model download, GPU benchmark,
Mac/ARM run, native toolkit build, desktop installation, or live screen-reader audit was performed.
Upstream branches and terms are moving targets; pin/review them again when implementing.

F0 subsequently ran the Windows suite/control and source build checks; its
[baseline report](baseline.md) distinguishes passes, setup-dependent failures, diagnostic failures
and unverified platforms. F1, Windows F2 and the Node cutover now have separate execution receipts.
The next implementation work is **F7 release qualification**. Follow the
[roadmap's ordered changes](roadmap.md#first-implementation-changes).
[D-041 and D-042](../docs/internal/decisions.md) record the stack and repository decisions. Model
selection and hardware support remain qualification work, not newly certified by this plan.
