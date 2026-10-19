# SpriteBook's next version

**Start here.** This is a decision set for a substantial remake that preserves SpriteBook's product
vision. Research date: **2026-10-18**. Repository base: `42be3bbebfc783edb42fb64001aa9b2e3d638c98`.

**Confirmed by the maintainer:** keep Tauri as the desktop shell, keep TypeScript as the main
product core and CLI, and replace Deno. These choices are settled for this migration; GPUI, separate
native shells, and a full Rust core are not active tracks. Existing product contracts, dependency
policy and implementation remain in force while the migration is planned.

**Repository strategy approved:** migrate this repository incrementally, preserving its packages,
tests, fixtures and history. See the [accepted strategy](migration-strategy.md) and
[migration roadmap](roadmap.md). The plan targets supported Node LTS and qualifies Node/Dawn first;
exact dependency pins and renderer adoption still require the stated checks. Implementation has not
started; the roadmap is now the single route for migration work.

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
- **Undo has a reproduced asset-consistency defect.** Picking A, picking B, then undoing restores
  A's metadata while leaving B's canonical GLB. Fix this with the known transaction/concurrency gaps
  before trusting a migration.
  [Reproduction and proposed repair](architecture-review.md#safety-work-before-migration).

## How this review was done

Validation for this documentation change: Markdown formatting, local link/anchor checks, source
spot-checks, and one isolated CPU-only reproduction through the real CLI implementation. The
historical repo performance/proof logs were read, not rerun. No model download, GPU benchmark,
Mac/ARM run, native toolkit build, desktop installation, or live screen-reader audit was performed.
Upstream branches and terms are moving targets; pin/review them again when implementing.

The next implementation task is **F0-T4/F0-T1: capture the control and conformance baseline**, then
the shared writer/recovery fix in **F1-T2**. Follow the
[roadmap's ordered changes](roadmap.md#first-implementation-changes).
[D-041 and D-042](../docs/internal/decisions.md) record the stack and repository decisions. Model
selection and hardware support remain qualification work, not newly certified by this plan.
