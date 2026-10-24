# Dependable first animated character

Approved by the maintainer on 2026-10-23. This extends F5-T2/F6-T1 and qualifies their assembled
workflow through F6-T4. The research and rationale are in
[generator animation readiness](generator-animation-readiness.md).

## Current result

Implementation is on `main`; the complete quality milestone remains open. The offline authored
journey, early candidate audition and delivery/recovery checks work. All 32 valid-reference
generated candidates have been reviewed: 24 complete technically and eight refuse downstream. All
four skirts and one relaxed-arm character fail visual motion review despite completing exports.
Additional flawed-input stress cases are recorded separately. Neither the ownership repair nor the
authored appearance replacement qualifies on the retained character, and no complete
prepared-garment walk/jump set passes. See [cohort results](character-cohort-results.md),
[ownership findings](ownership-reference-hardening.md) and
[garment findings](prepared-garment-reference.md). Failed trials are retained.

## Acceptance work

- [ ] **Reference:** offline CC0 authored rig through walk, jump start/air/landing, side-view and
      eight-direction natural sprites and engine-compatible export. A separate prepared garment must
      pass shape/contact/loop review before a cloth provider is qualified.
- [x] **Cohort:** eight rights-cleared reference designs, two recorded seeds, both integrated
      generators; same documented downstream recipe and retained failures. Report per-character
      quality separately from technical completion, costs and intervention. Keep private user
      characters as regressions, not redistributable benchmark fixtures.
- [x] **Early audition:** input preparation guidance, draft-rig walking/jumping, useful source-bound
      diagnostics and original/candidate comparison before look/bake. No unbounded retries or
      automatic acceptance based on a numerical score.
- [ ] **Preparation:** a reviewed ownership/attachment route, refusal of ambiguous regions, and a
      separate authored-template appearance experiment. Preserve identity, asymmetry and source
      bytes. A successful Blender invocation is not a successful correction.
- [ ] **Delivery/recovery:** sprite framing, alpha, timing, pivots, directions and preview/bake
      agreement; cancellation/retry, low disk and preservation of accepted assets. Keep capability
      and resource qualification per operation, with additional native/weaker hardware explicit.

## Delivered behavior and evidence

`import --example` opens the bundled CC0 authored body without downloading weights. `import --model`
preserves an existing skin, materials and exact source upload; static models still need rigging.
Import and undo/redo use the existing asset-aware manifest journal. Interrupted initial imports can
resume only against the same source and an untouched initial workspace.

Importer 0.1.1 fixes height/grounding on the actual skinned surface. Bounds metadata alone had
hidden a cancelled normalization. An independent three.js consumer measures a requested 1.6 m body
at 1.60000012 m, with feet within 0.00000016 m of the floor. Static armature inheritance is
retained; unsupported animated wrappers and shear refuse instead of publishing altered motion.

The final authored-import review also finds integer-encoded skin weights being normalized in their
integer storage, while core expects floats. Importer 0.1.2 decodes normalized 8/16-bit weights at
the border. Invalid weights and unsupported extra influence sets refuse with a preparation message,
preserving the original file. The controlled generated cohort finishes before this version is
compiled; its receipts remain unchanged.

`anim --audition` captures walk, takeoff, airborne jump and landing in core. Add `--result r1` to
test a generated candidate in a separate derived workspace with the original project pins. One
explicit UniRig attempt is reusable; the selected character, accepted rig, enabled clips, look and
bake stay untouched. Reports bind to source/clip/renderer inputs and show measured edge movement and
exact coincident separation. These are review aids, not anatomical or collision certificates. Studio
exposes the same commands and core playback before accepting a candidate or rig. New image projects
start at one candidate and explain pose/clothing limits; comparison respects the selected candidate
budget. Catalog material-retry limits still apply and effective seeds remain provenance.

An explicit upright opt-out is available for already upright candidates refused by alignment. It
keeps a separate draft recipe and report; the default attempt and selected character remain intact.
One separate copied-workspace recovery completes draft rigging and four-motion review in 200
seconds, then delivers 72 side-view and 288 isometric frames without render flags. This recovery
does not replace its failed default attempt in the controlled cohort. Missing or empty derived
images/previews invalidate a cached review; retry rebuilds them using the existing draft rig.

The cohort also exposed cropped candidate thumbnails on broad bodies. The shared generation and
retexture thumbnail now fits projected width, height and depth without changing the mesh or bake
camera. A real broad-character replay moves its horizontal silhouette from both image edges to a
12px inset; the wide-subject GPU regression preserves the complete card silhouette.

The corrected authored reference produces 104 side-view and 416 eight-direction isometric frames for
walk and all three jump phases, with no render/clipping flags. Godot, TexturePacker, strips and the
model export complete. The packer keeps a complete clip/direction on one page when it fits;
oversized sequences retain every frame and the existing format refusals. All AOVs share one layout.

Delivery checks establish byte-exact equality between a selected Look frame and its atlas crop, 100%
cache replay hits, alpha, timing, loop flags and pivots. Real 4096×4096 cells export through all
three sprite targets; this is a two-frame 4K delivery check, not high-resolution animated
character-quality acceptance. The source mesh, manifest and journal remain byte-identical.

Cancellation/retry preserves the prior motion review. Export preflights unsupported target/page
combinations before writing any selected target. Low-disk, license and platform refusals occur
before optional-tool downloads. A real killed fixture installer leaves its previous selection
intact; retry reclaims only its marked stage, verifies the new fixture and preserves an external
program. Junctions, unmarked directories and malformed markers remain protected. These checks do not
claim transactional recovery from every filesystem failure during multi-target publication.

Reproducible proof entry points are `tools/proofs/first-character.ts`,
`first-character-delivery.ts`, `character-cohort.ts`, `character-cohort-evaluate.ts` and
`tool-recovery.ts`. Private evidence is under `.render-bench/e2e-reference-2026-10-23-r4/`,
`.render-bench/first-character-delivery-2026-10-23-r3/`, `.render-bench/import-surface-2026-10-23/`,
`.render-bench/tool-recovery-2026-10-23/` and the cohort/research roots linked by their reports.
Earlier failed runs remain separate.

The independent thumbnail replay is in `.render-bench/thumbnail-framing-2026-10-23/`; its corrected
card is separate from the original controlled cohort outputs.

The explicit alignment recovery is in `.render-bench/candidate-orientation-2026-10-23/`. The Studio
motion-review proof is in `.render-bench/first-character-ui-2026-10-23/`, including
`candidate-orientation-final.png`. Both use private copies, leaving live character projects intact.

## Qualification limits

The authored path avoids CUDA generation/rig inference; sprite rendering still needs a working
graphics backend. Windows x64 on the recorded host is the tested environment. CPU geometry checks,
WebGPU rendering, each CUDA model and optional Blender have different resource requirements; the 24
GiB test GPU is not an app minimum. Additional native platforms and weaker hardware remain
independent qualification work.

Studio browser checks use the full app with real Windows Node CLI jobs in an isolated workspace,
including playback, cancellation/retry, keyboard resizing, the minimum viewport, both themes,
Spanish and expanded pseudo-localization. They do not substitute for the native Tauri keyboard
journey. Godot/Unity engine integration, signing and notarization are outside this pass. Blender
stays optional and no unqualified garment solver, repair, segmentation provider or generic plugin
runtime is adopted.

The final compiled suite on 2026-10-24 records 960 tests: 953 pass, seven explicitly skip, none
fail. Source/frontend/test type checks, lint, formatting and the production web build pass. Skips
are the opt-in real-backend monolith, separately configured U²-Net integration, four real
engine/tool imports and the native keyboard walkthrough. The 44 actual model trials and
exported-sheet checks are recorded separately; they do not substitute for those engine/native
interaction gates.

## Implementation order

1. Preserve imported rigs and expose the bundled reference without model downloads. Validate actual
   exports before expanding the quality pipeline.
2. Establish reproducible benchmark inputs and launch bounded sequential generation/rigging jobs.
3. Add core motion audition/reporting and the matching Studio controls, using the existing
   retargeter and renderer. Diagnostics do not certify anatomy or collision-free animation.
4. Use the failing cases and clean controls to isolate preparation/correction defects. Promote only
   a method that improves detailed final motion, without inventing missing anatomy.
5. Complete the native Windows journey and recovery checks, review code/docs and record measured
   outcomes. Keep heavyweight new providers and all other platforms behind independent admission and
   qualification; Blender stays optional.

An AniGen inference comparator is conditional on dependency admission and a supported execution
environment. Neither an upstream claim nor a permitted download counts as a SpriteBook quality win.
No release, tag, generic community-plugin runtime or silent source replacement is implied by this
milestone.
