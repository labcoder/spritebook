# Guided motion repair: implementation and trials

2026-10-23, F5-T2/F6-T1 and F3-T2. Follow-through on the approved
[repair plan](animation-quality-options.md). **No Amy or Bulma correction qualifies for automatic
use.** Movement review before acceptance and resource checks land independently. Live character
assets and the v0.5.0 release remain unchanged.

## Coverage and decisions

| Plan item               | Executed                                                                                                                                           | Decision                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Guided binding          | Explicit ownership, constrained weights, same-surface harmonic fill, contact-face separation/cap preparation; public controls and 85 private poses | Useful known-region primitive; actual Amy corrections fail or refuse. No automatic replacement   |
| Prepared garments       | Exterior carrier, waist/free hem, detailed transfer, fitted colliders, authored control; CPU/Blender across walk and all jump phases               | Final contact, attachment, shape or loop checks fail. No solver adopted                          |
| Review workflow         | Rig inspector previews catalog clips through core before acceptance; recoverable failures and return to rest                                       | Shipping improvement; no unqualified repair acceptance UI                                        |
| Correction exchange     | Deterministic indexed arrays, identity/provenance validation, two cameras sharing one frozen corrected input                                       | Static proof passes; production animated parity/cache remains conditional on a useful correction |
| Optional tools/hardware | Existing-bpy operator/cancellation probe; actual host diagnostics/download-space gate                                                              | No mandatory engine/dependency. Maintained Blender and additional native hardware unqualified    |

Private scripts, exact hashes, reports and replay commands are under
`.render-bench/{ownership-repair,prepared-garment,optional-tool,deformation-exchange}-2026-10-23/`.
These are local evidence; private character assets are not bundled or uploaded to CI.

## Binding results

The aligned Amy proof has 595,107 render vertices, 799,985 triangles and 28 joints. Core walk,
jump-start/loop/land and arms-raised motion were frozen at 17 samples each. Weight-only candidates
preserve geometry, normals, UVs, indices, textures, hierarchy and inverse binds after serialization;
exact seams remain coincident during motion.

Private reviewed color/anatomy seeds are not automatic segmentation or complete ground truth. Hard
ownership constraints reduce worst per-frame P99 edge/rest from 5.635× to 2.769×, but visible skin
tethers and sleeve distortion remain. Separate removal of 597 transition faces (0.0746%) reduces
tethers but leaves clothing wings and open boundaries. Cuffs legitimately connect different owners;
a cross-owner face is not automatically a bad fusion. Both candidates are rejected.

Conservative cap preparation refuses all 12 simple closed loops: five exceed its local-hole extent
bound; seven have ambiguous UV seams. Four other boundary components are open chains. It adds zero
vertices/faces rather than inventing missing shape or texture.

A generic harmonic-fill prototype follows authored edges within explicit regions, with allowed joint
sets and trustworthy anchors. It never joins nearby disjoint surfaces. Controls pass:

- Two sheets 1 mm apart recover a corrupt weight patch within 3.115e-7 without neighboring leakage.
  Cross-owner triangles are detected; conflicting coincident owners/anchorless components refuse.
- On the bundled CC0 authored female, clean motion changes less than 0.00009 mm. Injected thigh
  leakage causing 0.724–1.111 m maximum error falls to 8.98–12.39 mm across walk/jump. This is
  improvement, not exact reconstruction of authored weights.
- The conservative solver refuses Amy's selected anchorless components. It does not invent a
  nearest-bone fallback.

Next gate: complete reviewed ownership/reference input that fixes hands, cuffs and trousers
together. Better trouser statistics and clean controls do not establish actual-character quality.

## Prepared garment results

A coherent 1,536-vertex exterior carrier has waist pins and a free hem. Both methods retain all
81,003 selected detailed vertices and 163,557 original garment triangles. A dense garment need not
itself be a thin manifold sheet, but its volume/layers need unambiguous correspondence. Probes still
find missing hits/multiple layers. The selected body lacks complete hidden upper-thigh coverage; no
anatomy was invented.

CPU and existing Blender use the same prepared motion/collider inputs. Their detail-transfer methods
differ, so this is not a solver-only causal comparison. Seventeen samples per clip check final
detailed triangles, actual retained-body crossings, attachment strain, seams and self-crossings.
These are sampled checks, not continuous collision certification.

| Evidence                                | CPU                         | Existing Blender                             |
| --------------------------------------- | --------------------------- | -------------------------------------------- |
| Clean control walk, worst P99 edge/rest | 1.529×; shape fails         | 1.122×; sampled contact/shape pass           |
| Clean control jumps                     | Contact or shape fails      | Some sampled phases pass; start/landing fail |
| Actual detailed skirt walk              | 3.440×; waist/coverage fail | 4.214×; waist/coverage fail                  |
| Actual detailed skirt landing           | 6.137×; contact/shape fail  | 6.958×; contact/shape fail                   |

The clean Blender walk's loop mismatch falls from 73.77 mm to 25.48 mm after three cycles, removing
pelvis motion, but five final triangle/capsule contacts appear. No forced blend/threshold change
hides this failure. Actual landing self-crossings increase from 218,953 original-LBS observations to
about 1.69 million CPU /8.66 million Blender. These sum triangle-pair observations over time, not
unique triangles. Core images show waist tears/coverage loss, regardless of contact scores.

Detailed simulations take about 17–20 s CPU /111–117 MB process-tree RSS and 7.1–7.7 s Blender
/679–706 MB. Validation costs are separate; concurrent work makes these bounded workload costs, not
isolated benchmarks/minimum hardware. Each worker has a 180 s limit. Complete garment ownership and
stable detailed waist attachment remain prerequisites; more iterations are not the next fix. This
extends the negative [cloth evaluation](cloth-evaluation.md) to full clips and controls.

## Exchange and optional-tool proof

Twenty correction-exchange check groups pass, including 16 corrupt candidates rejected. Indexed
position/normal data records source/rig/clip/solver identities and strict times while preserving
UVs/textures/bones. Side/isometric core renders reuse one corrected pose and full-recorded-clip
bounds; repeated renders match per camera. This proves static exchange, not animated parity.

Production adoption would reach schema/CLI selection, clip preparation, position/normal streaming,
corrected bounds, cache identity and both preview/bake consumers. World positions must not be
skinned twice. Current animation is joint-TRS; a Blender morph GLB alone does not work throughout
core. Preserve original-model export semantics. Dense corrections cost 24 bytes/vertex/frame, about
14.4 MB/frame at 600k vertices before compression. Defer that deployed storage contract until a
useful correction and affected region are known.

Bounded discovery finds no standalone Blender on PATH/ordinary install locations. Existing research
bpy 4.2 passes import, armature/weight, tiny cloth and export operators. Six process/output checks
cover malformed output, nonzero exit, timeout, descendant termination, cancellation and unrelated
installation preservation. Blender export splits hard-normal vertices: exchange neutral indexed
corrections rather than claiming whole-GLB round trips preserve source indices.

No tool was downloaded. Research bpy 4.2 is not a qualified new baseline; standalone flags,
maintained Blender and native Mac/Linux/ARM remain unmeasured. The maintainer's Blender integration
decision remains open. It stays optional even if later adopted.

## Product changes and remaining work

Rig's **Motion check** uses existing catalog clips and `anim --preview`. It does not enable clips,
accept the rig, change source bytes or refresh the manifest as a mutation. Core retargeting remains
shared with Animate/bake. Return to rest restores editing; pending edits block playback.

Installation checks destination free bytes against pinned model files before staging/network work.
Unknown capacity warns; known insufficiency refuses retryably. This is a lower bound, not
expanded-runtime/concurrent-write budgeting. `doctor` reports RAM, process-available memory and
physical NVIDIA UUID/free/total inventory. Snapshots neither identify CUDA ordinals nor prove
kernels, and board-capacity floors are not free working-memory requirements.

No dependency, model download or physics engine was added. Keep the current binder/player and
F5-T2/F6-T1 gates open. Next: trustworthy ownership/reference preparation and complete attachment
correspondence, then actual-character checks before provider adoption or a full deformation cache.
Weaker/native consumer GPUs, maintained Blender and continuous collision need separate
qualification.

## Verification

Full suite: 928 passed /7 explicit skips. Source/test/frontend checks, lint, formatting and the
production web build pass. Browser replay exercised real walk/jump previews on an isolated
character, rest recovery, transport failure/retry and unchanged source/manifest bytes. Checked
English/Spanish 960×600 layouts have no page overflow or detected WCAG A/AA violations; 1440×900
dark was inspected. These checks do not qualify native installed desktop execution or additional
hardware. Private UI proof/screenshot: `.render-bench/motion-repair-2026-10-23/`.
