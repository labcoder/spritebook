# Vision and decision brief

Research snapshot: **2026-10-18**. The maintainer has confirmed **Tauri desktop, TypeScript product
core/CLI, and replacing Deno**. Other implementation and product proposals remain open. The current
PRD, invariants and runnable implementation remain the baseline. The maintainer has now approved
incremental migration in this repository; the finalized [roadmap](roadmap.md) defines that route.

## The product to rebuild

**Turn one character reference or supplied model into an entire game's coherent, animated sprite
roster.** Preserve the founding idea: 3D is how we make the assets; readable, consistent 2D sprites
are what the user buys into. SpriteBook should remain useful without AI generation: importing a
mesh, animating it, changing a roster's look, and exporting to an engine are complete workflows.

Keep the six stages: **Generate/import → Rig → Animate → Look → Bake/review → Export**. Preserve
asymmetric identity, world-locked scale, core-rendered pixel previews, reversible decisions,
headless automation, incremental rebakes, and honest model readiness. These are product advantages
independent of TypeScript, Rust, or a desktop framework. See the [current PRD](../docs/prd.md).

## Why remake it now

The runtime migration is justified. Deno's October 9 announcement gives its runtime another year of
fixes before the team's development ends. Treat roughly October 2027 as the planning horizon, not an
immediate outage. [Deno announcement](https://deno.com/blog/cloudflare).

A rewrite should also fix the larger usability promise: a clean-machine install that can explain
what works on this machine, get to the first usable sprite quickly, and scale to hundreds of
characters. The current code already contains valuable work, while its packaging, asset undo, model
provisioning, and process lifecycle need attention. The
[architecture review](architecture-review.md) separates those facts from proposals.

## Recommended direction

**Keep Tauri and the TypeScript core, and modernize this repository incrementally.** The desktop and
language choices are settled; a full Rust core, GPUI editor and separate native shells are not part
of this migration. Preserve the existing React implementation inside Tauri while improving the
product experience.

The approved strategy is to migrate this repository rather than create a new one. Retain working
packages, tests, fixtures and history; replace Deno's execution/tooling and weak ownership
boundaries in reviewable changes. Node LTS is the recommended replacement runtime, with Node/Dawn
qualified first to keep the renderer's TypeScript host code. A focused native GPU worker remains a
contingency if that path fails; it would not move product behavior out of TypeScript.
[Repository strategy](migration-strategy.md) explains why. [Runtime migration](runtime-migration.md)
defines the unresolved engineering gates.

The migration roadmap is now finalized for this strategy. It separates the required Deno exit from
later model and editor improvements. This documentation update records the approval and plan;
implementation and hardware qualification have not been performed.

Keep Python or an audited native inference runner for models that need it. Rewriting the UI or
orchestrator does not make a CUDA-only model run on Metal. Hugging Face remains an artifact source;
SpriteBook owns readiness, receipts, pins, and the workflow. [Model management](model-management.md)
explains the actual integration.

## What the redesigned experience should do

| User need                   | Proposed experience                                                                                                                                 | Existing behavior worth carrying forward                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Get a first sprite          | Start with image, mesh, or a sample; show the shortest valid next action and a small core-rendered strip early                                      | Import shortcut, canonical-mesh checkpoint, six stages                           |
| Know whether AI will work   | Model cards say supported, experimental, or unavailable for the detected runtime and hardware; show total download and access steps before starting | Catalog-driven fields, explicit install gates, synthetic fixture clearly labeled |
| Preserve character identity | Source/result comparison at sprite size; asymmetry remains opt-in to mirror; keep decal, reprojection, attachment, and body-fit paths               | Identity operations and both rig tracks                                          |
| Recover from mistakes       | Undo restores the asset actually used by the next bake; errors offer retry only when meaningful; jobs can cancel                                    | Journal, stable IDs, raw event drawer, QA links                                  |
| Manage a roster             | A roster overview shows stale reasons, shared look presets, queued work, and a morning report; a character editor provides detail                   | Bake plans, cache inputs, per-character isolation                                |
| Judge the output            | Nearest-neighbor integer zoom, animated directions, AOV inspection, keyboard sandbox, and engine import confirmation                                | Core pixels and preview/export parity                                            |
| Automate later              | Each primary action has its CLI twin; reads and batch actions are available through core too                                                        | Arg builders and CLI parity tests                                                |

Keep accessible focus, localization, reduced motion, sentence-case outcome verbs, and dark canvas
wells in either theme. These are acceptance criteria for a new UI. The existing
[design system](../docs/design/design-system.md) is the current visual contract; new layout or
art-direction concepts should be reviewed separately from choosing a rendering or UI library.

Text input is an **optional upstream step**: prompt → inspectable reference image → the same
character pipeline, with both prompt and reference recorded. Do not claim all image-conditioned
models accept text. A native text-conditioned adapter can join only after it passes the same output,
license, and reproducibility gates. Image generation itself needs its own audited model and
benchmark; it is not supplied by the three named 3D models automatically.

## Decisions for the maintainer

| Decision            | Recommended default                                                                             | What choosing otherwise commits us to                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Repository strategy | **Approved: migrate this repository incrementally**                                             | Preserve existing packages, history, tests and artifacts; no parallel replacement app          |
| Language            | **Confirmed: TypeScript core and CLI**; recommend Node LTS                                      | A full Rust core is outside the selected scope                                                 |
| Desktop             | **Confirmed: Tauri**; preserve the current React UI                                             | GPUI and separate native shells are historical alternatives, not work to schedule              |
| Runtime and GPU     | **Confirmed: leave Deno**; recommend Node LTS and Node/Dawn first                               | Exact runtime/native dependencies still need qualification and approval                        |
| OS promise          | Cross-platform import/animate/bake/export; publish model-specific AI tiers                      | Universal local generation requires measured Apple Silicon and AMD runners, not just OS builds |
| Model priority      | Retest TRELLIS.2 and Pixal3D via current implementations; Hunyuan only behind appropriate terms | Supporting every model multiplies environment, license, and QA work                            |
| HF relationship     | Keep Hub distribution; own installation and project pins                                        | Depending on another app's private cache/backend gives it control over reproducibility         |
| Cloud scope         | Keep local-first and offline operation as the baseline                                          | Hosted generation is a new privacy, cost, and product decision; not required for this redesign |

## Product laws and success criteria

Carry forward all eight [architecture laws](../docs/architecture/architecture.md), and prove them at
the artifact boundary, not just in JSON. Canonical glTF, one retargeter, one pixel-truth renderer,
input-derived cache keys, BakeManifest projections, aligned AOV layouts, recorded provenance, and
journaled edits are mandatory in every technology track.

Retain the PRD targets: **mesh → sheet ≤10 minutes; image → engine-imported character ≤30 minutes;
100-character look pivot overnight; idle flicker ≤1.2% under the defined preset workload; zero
surprise downloads**. Publish machine, model/runtime/configuration, workload, and quality with each
measurement. Existing Windows measurements are a baseline, not evidence for all OSes.

The [roadmap](roadmap.md) orders the required migration and separates later improvements. D-041
records the desktop/language/Deno-exit choice; D-042 records approval to migrate this repository.
Exact dependency pins, model defaults, hardware support and schema changes still need their normal
implementation evidence. The internal release target is a planning buffer, not a delivery promise.
