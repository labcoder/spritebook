# Generator choice and animation readiness

Research date: 2026-10-23. This records the original primary-source review. The approved
implementation and its measured outcomes are tracked in
[the first-character milestone](first-character-hardening.md),
[cohort results](character-cohort-results.md), [ownership trial](ownership-reference-hardening.md)
and [prepared-garment trial](prepared-garment-reference.md). See also the
[current binding/clothing evidence](binding-clothing-followup.md),
[maintained Blender trial](maintained-blender-trial.md) and
[platform spike](model-platform-spike.md).

## What the current failures establish

Amy's reviewed binding candidate reduces whole-character stretch but still produces skin tethers and
jacket wings. Bulma's improved source-boundary attachment keeps the waist more continuous but does
not fix the crumpled skirt or body intersections. These are measured failures on specific assets and
methods; they do not establish a failure rate for a generator family. Switching Blender versions
reproduced the retained cloth outputs exactly. An engine upgrade alone is not the fix.

Distinguish three inputs: an authored **rigged** mesh with known-good motion, an authored **static**
mesh that still needs binding, and a generated/reconstructed static surface. Preserve a good
existing rig rather than automatically replacing it. A GLB container, UVs, PBR material or low
triangle count is not evidence of correct anatomical ownership or garment attachment.

## What the generators actually offer

| Release/path            | Primary-source output                                                                                                                                                                                                 | Consequence for SpriteBook                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pixal3D current release | Pixel-aligned image-conditioned geometry and PBR GLB; current backbone is TRELLIS.2. Its multiview path uses separate weights and camera transforms/FOV, not arbitrary uncalibrated pictures.                         | Improved visible likeness does not certify independent clothing/body surfaces, bind weights or motion. Multiview may reduce unseen-side ambiguity; benefit to animation needs measurement. [Official README](https://github.com/TencentARC/Pixal3D)                                                                                                                          |
| TRELLIS.2               | Textured shape generation; representation explicitly accommodates open surfaces, nonmanifold geometry and enclosed structures. Export performs cleanup, optional dual-contouring remeshing, UV unwrapping and baking. | Do not require all valid source detail to be a single watertight surface. Export remeshing changes topology but is not a promise of humanoid joint loops, separated clothing or skin weights. [README](https://github.com/microsoft/TRELLIS.2), [export implementation](https://github.com/microsoft/TRELLIS.2/blob/main/o-voxel/o_voxel/postprocess.py)                     |
| Hunyuan3D 2/2.1         | Shape plus a separate painting pipeline; 2mv supplies multiview shape conditioning, 2.1 supplies PBR materials.                                                                                                       | Another candidate source for static assets, not an established cure for the binding/cloth preparation demonstrated here. [2.x README](https://github.com/Tencent-Hunyuan/Hunyuan3D-2), [2.1 README](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1)                                                                                                                        |
| SF3D / SPAR3D           | UV/material-bearing GLB; optional triangle/quad remesh. SPAR3D adds editable point-cloud conditioning for unseen geometry.                                                                                            | Worth testing as cheaper candidates, without inferring animation quality from mesh count or quads. SF3D's own demo warns remeshing can damage thin surfaces. [SF3D](https://github.com/Stability-AI/stable-fast-3d), [demo warning](https://github.com/Stability-AI/stable-fast-3d/blob/main/gradio_app.py), [SPAR3D](https://github.com/Stability-AI/stable-point-aware-3d) |

The reviewed static-generation interfaces do not make animation readiness a validated output
contract. This is a scope observation, not proof that every resulting mesh is defective. The
[matched SpriteBook trial](character-cohort-results.md) compares their actual downstream behavior;
its small procedural cohort does not establish a general reliability ranking. The current
Pixal3D/TRELLIS.2 relationship also makes them less independent than their names imply.

## Alternatives that change the problem

1. **Known-good body and deformation carrier.** Test a licensed authored humanoid with established
   weights, fitting a lower-resolution deformation surface and transferring visible detail. Keep
   skirts/hair as separate owned surfaces where present. This changes the task from guessing all
   anatomy to preserving a known articulation. It is a proposed experiment: close touching surfaces,
   unusual proportions and multilayer clothing still make correspondence ambiguous. Do not impose a
   template silently or substitute an incompatible body; retain original and candidate together.
2. **Joint generation of shape, skeleton and skin.** AniGen explicitly models all three fields,
   emits rigged GLB and publishes weights. It is a closer objective match than generating a static
   sculpture followed by unrelated rig inference. Upstream tests Linux/NVIDIA, asks at least 18 GB
   GPU memory and distinguishes geometry/detail-oriented checkpoints; joint-density settings can
   damage weights. This is a bounded research comparator, not demonstrated SpriteBook support or
   quality. [Official code](https://github.com/VAST-AI-Research/AniGen),
   [weights/model card](https://huggingface.co/VAST-AI/AniGen).
3. **Guided part masks before weight repair.** P3-SAM provides released native-3D automatic and
   point-prompted segmentation. Test whether a few user clicks can resolve hand/cuff/trouser
   ownership, with unresolved regions shown explicitly. A predicted mask is not a certified body,
   clothing layer or trustworthy weight anchor. X-Part targets part completion, but its nested
   README still marks pretrained release/download TODO, despite the root overview; inspect actual
   files before treating it as runnable.
   [P3-SAM](https://github.com/Tencent-Hunyuan/Hunyuan3D-Part/blob/main/P3-SAM/README.md),
   [X-Part status](https://github.com/Tencent-Hunyuan/Hunyuan3D-Part/blob/main/XPart/README.md).
4. **Motion-aware candidate selection.** Rank generated candidates after inexpensive rig plus
   walk/jump probes, before users invest in look development or a full bake. Keep visual likeness,
   silhouette quality, source integrity and motion checks separate; lower stretch alone already
   selected visibly bad repairs in our experiments. Offer a focused retry or guided repair, not
   repeated unbounded generation. Explicit draft-rig audition now uses the existing pipeline;
   automatic quality ranking remains unqualified.

## A bounded comparison before choosing another default

Start with retained meshes and explicit rights-cleared authored controls, then generate matched
inputs where needed. Proposed first cohort: eight reference designs, two fixed seeds each, both
integrated generators; retain failures rather than cherry-picking candidates. Include fitted clothes
and separated limbs, relaxed arms near trousers, loose cuffs, skirt, long hair/accessories, stylized
proportions and asymmetry. Add known-good rigged assets plus deliberately corrupted controls to
separate generator, binder, retargeter and renderer failures. Bulma/Amy remain private regressions,
not distributable fixtures or the whole benchmark.

Use identical input preparation, documented source pose, camera assumptions and downstream rig
recipe. First compare shipping recipes at similar resource budgets; quality/latency differences from
different recipes are not pure model effects. Record multi-seed variability and exact pins. Then
isolate remesh, binder or part-selection changes one at a time.

Evaluate rest pose, walk, jump start/air/land and raised arms; side-view and eight-direction
isometric sprites at 64, 256 and higher resolution. Inspect original detailed surfaces, UV seams,
coverage, hand ownership, foot contact, silhouette, loop endpoints, texture shimmer and bounds.
Report technical completion separately from motion quality, and report quality per design/clip
instead of hiding a skirt failure in an average. Verify preview/bake parity and export
timing/pivots. Sampling is an acceptance aid, not continuous collision certification.

The most useful product metric is first acceptable walk-and-jump export, including time, retries,
downloads, intervention and visible defects. “Generated a valid GLB” is an intermediate result.

## Recommended next milestone: a dependable first animated character

Approved by the maintainer on 2026-10-23. Execution and measured acceptance live in
[the first-character milestone](first-character-hardening.md); approval does not establish quality
qualification. Work F5-T2/F6-T1 into an F6-T4 proof in this order:

1. **Establish the reference.** Reuse a rights-cleared authored character and bundled clips for a
   small offline project that reaches walk/jump preview, bake and export without model downloads.
   Independently qualify a simple, separated garment through jump and loop closure before using it
   as evidence for a cloth repair. The current clean cloth trials still fail those checks; source
   meshes are not the only unresolved variable. A carefully prepared Blender reference can establish
   the required setup; an executable/operator check cannot.
2. **Measure the current generators.** Run the bounded cohort above before installing another
   heavyweight provider. Preserve generator/recipe/seed provenance and isolate preparation, binding,
   clip and renderer changes. A successful process exit and a lower stretch percentile must never
   stand in for acceptable detailed motion.
3. **Move discovery earlier.** Before generation, explain or highlight occluded hands, touching
   limbs and clothing that may need preparation. Offer reviewed reference-pose changes rather than
   silently redesigning the character. After a draft rig, audition walk/jump and render a contact
   sheet at the intended camera and sprite size. Compare existing candidates on likeness and motion
   separately. Bound any extra generation by an explicit cost/retry policy.
4. **Prove one recoverable preparation route.** Start with reviewed hand/cuff/trouser ownership and
   garment attachment/collider coverage on retained failures. Show what belongs to each part, refuse
   ambiguous anchorless regions, and keep original/candidate side by side. In a separate experiment,
   fit an authored body and separate garment templates, then transfer appearance. That route
   intentionally changes the underlying surface and needs identity/silhouette review; it is not the
   already-rejected nearest-donor weight transfer under a new name.
5. **Validate the whole delivered result.** Check side-view and eight-direction sheets, loop timing,
   framing, pivots, transparency and preview/bake agreement. Exercise interruption, retry, low disk
   and preservation of accepted assets. Report per-character visual failures, downloads, latency and
   user intervention. Qualify hardware per operation; a CPU-friendly authored-rig path should not
   inherit a CUDA generator's machine requirements.

After a prepared reference passes, compare lighter sprite-oriented corrections with full cloth:
coherent garment helper joints, reviewed pose correctives, or explicit gentler motion variants. An
authored body-under-clothing visibility mask can prevent selected poke-through, but needs coverage
checks across the selected motion/views and must remain a reversible derivative. None of these may
silently alter a 3D export or pretend to reconstruct missing anatomy. Prioritize the final visible
result without relaxing the shared preview/bake contract.

This is consistent with how a production cloth workflow separates fitted clothing, simulation and
render meshes, weight maps and collision assets, then tests the assembled result. It is not a reason
to integrate a game engine:
[Epic's panel-cloth workflow](https://dev.epicgames.com/documentation/en-us/unreal-engine/panel-cloth-editor-overview).
Confidence-based weight transfer is also an established approach, but assumes a suitable source and
does not eliminate the ownership problems found in our trials:
[Robust Skin Weights Transfer](https://www.dgp.toronto.edu/~rinat/projects/RobustSkinWeightsTransfer/).

## Hardware and admission limits

Keep the app/renderer, generator and rigger compatibility separate. Existing SpriteBook native
qualification remains Windows x64; CUDA generator qualification on the available 24 GiB card is not
an application minimum. CPU-based import, authored-rig workflows and optional Blender jobs must
retain their own measured budgets. Other native platforms/weaker machines remain unqualified.

Upstream reference requirements are not SpriteBook measurements: TRELLIS.2 asks 24 GB NVIDIA/Linux;
SF3D quotes about 6 GB CUDA with experimental Windows/MPS; SPAR3D quotes 10.5 GB or roughly 7 GB in
low-memory mode. SPAR3D's README also retains a conflicting copied 6 GB sentence: use its dedicated
memory section and measure the exact recipe. Full AniGen weights are described as about 23 GB,
excluding environment/staging. None establishes system RAM, runtime disk or weak-device latency for
this application. See the primary READMEs above and the existing platform spike.

Retain exact-file/model/runtime license admission. AniGen labels core code/weights MIT, but its
third-party notice identifies noncommercial NVIDIA CUBVH code; upstream says this is needed for
training, not inference. Audit the actual inference dependency closure before adoption, including
normal/vision weights and dynamic downloads.
[Third-party notice](https://github.com/VAST-AI-Research/AniGen/blob/main/THIRD_PARTY_LICENSES.md).
Hunyuan 2.1 and Part agreements restrict model use and outputs outside their defined territory,
excluding EU/UK/South Korea; they are unsuitable as an unrestricted worldwide default.
[2.1 terms](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE),
[Part terms](https://github.com/Tencent-Hunyuan/Hunyuan3D-Part/blob/main/LICENSE). SF3D/SPAR3D
require their gated custom terms; a smaller download is not a license exemption.
[SF3D agreement](https://huggingface.co/stabilityai/stable-fast-3d/blob/main/LICENSE.md).

The original primary-source review executed no new generator, segmentation method or portable
engine. The subsequent matched trials use the two existing generators; their results are linked
above. Other proposed providers remain hypotheses until whole-character motion and final sprite
output pass.
