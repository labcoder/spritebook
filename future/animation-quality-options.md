# Animation quality: rigging, clothing and Blender options

Investigation dated 2026-10-23; the maintainer subsequently approved the bounded experiments below.
Private experiments use recoverable character copies. Deployment of Blender remains undecided; no
new binder or cloth solver is integrated. Nothing in this investigation authorizes a release. This
note supersedes the initial recommendations in the earlier
[garment research](garment-skinning-research.md) where subsequent experiments rejected them; those
negative results remain useful evidence.

**Execution results:** [CPU binding, DQS and motion controls](cpu-deformation-evaluation.md),
[TokenRig and portable inference](tokenrig-evaluation.md), and
[fitted garment / cloth comparisons](cloth-evaluation.md). The fast CPU binder and TokenRig have not
passed the whole-character quality gate. Blender automatic weights fail both generated inputs. Keep
the current pack and binder while resolving surface ownership and garment preparation; do not make a
larger optional install the default merely because inference completes.

The subsequent approved [guided repair trials](guided-motion-repair.md) cover explicit ownership,
conservative separation/capping, prepared cloth through full walk/jump clips, correction exchange
and optional existing-tool checks. No actual-character repair passes. Movement review and resource
checks land independently; full deformation integration and Blender deployment remain unselected.

## Recommendation

Keep the current animation pack and TypeScript retarget/render core. Under the maintainer's
cross-platform/low-footprint requirement, prioritize a **lightweight CPU repair path**, then qualify
optional learned binders and garment tools independently. CPU-first describes rigging and repair; it
does not promise that current image-to-3D generators run on every CPU.

The investigation now has three tracks:

1. **Portable CPU methods:** compare guided anatomical ownership, small geometric binders, corrected
   donor transfer, volume-preserving skinning and corrective deformation. Preserve the generated
   render surface; silently substituting Track A's canonical body is not an equivalent repair.
2. **Garment methods:** compare compact CPU constraints/XPBD with Blender preparation and detail
   transfer. Prefer a compatible existing Blender over another engine download. Both must improve on
   the rejected coarse polar-cage experiment, not repeat it with more iterations.
3. **Optional learned binders:** TokenRig skin-only versus current UniRig, followed by MIA v1 and
   viable CPU/Metal/Vulkan ports after license/platform screening. Preserve the exact mesh and
   skeleton for a weights-only comparison. A 24 GB NVIDIA card is not a baseline requirement.

If automatic ownership remains ambiguous, a short user-guided selection is a more credible recovery
path than cycling through model seeds. New characters should also get a pose/topology preflight
before the expensive rig stage. Approval to investigate these methods does not select a new shipping
provider or weaken the existing quality gate.

## What our evidence actually distinguishes

| Layer                       | Current evidence                                                                                                                                                       | What would resolve it                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skeleton placement          | Amy's displayed skeleton can fit the body while the mesh deforms badly. The aligned research copy has 28 joints; this is separate from the older tilted 34-joint copy. | Named anatomical chains, correct bind transforms and explicit missing-digit reporting. A larger joint count alone is not success.                                                                       |
| Surface ownership / weights | The retained raw UniRig output gives over 80% arm influence to 818 of 836 diagnostic outer-trouser samples, before SpriteBook transfers the weights.                   | A binder or guided region constraint that keeps hands, cuffs and trousers separate in motion.                                                                                                           |
| Retargeting                 | SpriteBook transfers rest-adjusted orientations and root motion; past retarget bugs justify keeping an independent control.                                            | Compare source/reference and target joint trajectories, bend ranges and contacts while holding weights fixed.                                                                                           |
| Playback / LBS evaluation   | A new independent Blender comparison agrees with core at the sampled walk times.                                                                                       | No evidence here that replacing the player fixes the remaining defect. This does not exonerate every retarget rule or every clip.                                                                       |
| Garment motion              | Bulma's skirt is already badly distorted by LBS before a collision correction is attempted. A knee can then cross it.                                                  | Garment-aware deformation, body collision and preservation of the detailed render surface.                                                                                                              |
| Source topology             | Existing Amy graph probes find contacting hand/leg neighborhoods even after controlled seam joins.                                                                     | Inspect and disambiguate the surfaces; do not assume that smoothing or nearest-distance transfer knows anatomy. A graph connection alone is not proof that every affected surface is irreparably fused. |

These are local findings, not claims from model benchmark tables. The diagnostic region samples are
not a general semantic classifier. Earlier donor, voxel-prior, distance-weight, capsule-push and
cloth-cage candidates were rejected visually, even when one numerical score improved.

### New independent Blender playback check

The installed isolated `bpy` 4.2 runtime imported the saved Amy and Bulma walk GLBs and evaluated
their armatures through Python. No GUI was opened. It retained the character vertex counts (595,107
and 628,916) and bone counts (28 and 52); imported bone-display helpers were excluded. Import plus
three geometry evaluations took about 4.7 seconds per character on this machine.

At normalized walk times 0, 0.5 and 1, bidirectional nearest-point comparison across all evaluated
vertices found maximum differences from core of 0.00093 mm for Amy and 0.00264 mm for Bulma. There
were no points above the 0.1 mm comparison tolerance. The endpoints repeat in this loop, so this is
a narrow cross-tool check, not full motion qualification or an index-by-index topology proof. It
compares already-retargeted clips and therefore cannot rule out an upstream retargeting error. Input
hashes were unchanged.

The subprocess completed its expected artifacts and then hit the known Windows `bpy` teardown access
violation. A production integration needs disposable processes, timeouts and independent artifact
validation; this experiment does not qualify that runtime as crash-free.

Private replay: `.render-bench/quality-research-2026-10-23/` contains `dump-playback.mjs`,
`blender-playback.py`, `compare-playback.py`, the input/output reports and intermediate arrays. The
dump uses emitted core modules; the Blender script uses the existing installed UniRig Python; the
comparison uses the existing sidecar NumPy/SciPy environment. No new package was installed.

## How games and VFX handle this

Production tools treat rigging, skinning and clothing as different authoring tasks. Unreal's
clothing workflow selects garment sections, paints movement masks and supplies a physics asset for
collision. This is evidence for a prepared garment/collider workflow, not an automatic
arbitrary-mesh guarantee.
[Unreal clothing authoring](https://dev.epicgames.com/documentation/unreal-engine/clothing-tool-in-unreal-engine?lang=en-US)

VFX workflows also use simulation and corrective shapes. Maya's pose-space deformation associates
corrective shapes with joint poses, including problem areas around shoulders, knees and groin.
Houdini's Vellum documentation explicitly discusses collision thickness, substeps, constraint
iterations and post-process detangling. It warns that detail/smoothing can introduce new collisions.
[Maya corrective poses](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-CharacterAnimation/files/GUID-00699C13-8CA1-450C-937D-57C7B3DFD8C6.htm),
[Vellum troubleshooting](https://www.sidefx.com/docs/houdini/vellum/vellumtips.html),
[Vellum post-process](https://www.sidefx.com/docs/houdini/nodes/sop/vellumpostprocess.html)

For SpriteBook, the useful advantage is that the delivered product is a finite set of sprite frames.
We can compute garment motion offline once per clip and reuse it for every camera direction; the
user's game need not run the solver. We must still simulate intermediate time steps, warm up and
settle loop motion, and check loop seams. Solving unrelated sparse output poses independently can
produce flicker or inconsistent cloth. This is a proposed application of those methods.

## Rig and skin-weight candidates

| Candidate                              | Why evaluate it                                                                                            | Platform / hardware evidence                                                                                                                                          | Decision                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **SkinTokens / TokenRig**              | UniRig's official successor; existing-skeleton skin-only mode isolates the binder.                         | Official CUDA setup advertises at least 14 GB NVIDIA VRAM. The 24 GB RTX 3090 fits that claim, but actual peak memory and native Windows kernels are unmeasured here. | First learned-weight A/B, behind provenance and runtime qualification.              |
| **Make-It-Animatable v1**              | Independent humanoid weights, pose reset and hand-focused geometry features; worthwhile if TokenRig fails. | CUDA-oriented PyTorch/PyG/PyTorch3D/bpy setup. No verified native Windows or inference VRAM floor in this investigation. CPU path exists; no qualified MPS path.      | Second experiment; full-rig comparison, not an exact-skeleton swap.                 |
| **Make-It-Animatable v2**              | Newer Hunyuan 2.1-backed model.                                                                            | More runtime dependencies; Hunyuan backbone has separate custom territory terms.                                                                                      | Separate gated candidate, not a silent upgrade of v1.                               |
| **Mesh2Motion solver**                 | Small TypeScript CPU binder and guided fitting reference.                                                  | Nearest-bone assignment, extremity/arm correction, adjacency smoothing; no CUDA. Large-mesh time is unmeasured.                                                       | Useful comparator / guided fallback, not a proven ownership repair.                 |
| **Blender automatic weights / Rigify** | Mature tooling for weight transfer, edits and fitted control rigs.                                         | CPU operations available without a model download; existing `bpy` works locally. Rigify requires fitting a metarig before generating controls.                        | Optional repair workbench; not a magical replacement for semantic binding or cloth. |

Sources:
[TokenRig setup and skin-only API](https://raw.githubusercontent.com/VAST-AI-Research/SkinTokens/main/README.md),
[MIA v1 setup](https://raw.githubusercontent.com/jasongzy/Make-It-Animatable/main/README.md),
[MIA geometry-aware method](https://arxiv.org/html/2411.18197v3),
[MIA v2 implementation](https://raw.githubusercontent.com/jasongzy/Make-It-Animatable/v2/model.py),
[Mesh2Motion solver](https://raw.githubusercontent.com/Mesh2Motion/mesh2motion-app/main/src/lib/solvers/SkinningAlgorithm.ts),
[Rigify fitting workflow](https://docs.blender.org/manual/en/latest/addons/rigging/rigify/basics.html?highlight=pose+mode).

### Qualification traps that affect the choice

- TokenRig's existing skeleton passes through coordinate tokenization. Its normal exported joints
  need not equal our original transforms. A valid weights-only A/B extracts influence columns with
  explicit joint correspondence and preserves original hierarchy, rest transforms and inverse binds.
  Unmatchable hierarchy is a failed comparison, not permission to guess nearest joints.
  [Tokenizer](https://raw.githubusercontent.com/VAST-AI-Research/SkinTokens/main/src/tokenizer/tokenizer_part.py),
  [output construction](https://raw.githubusercontent.com/VAST-AI-Research/SkinTokens/main/src/model/tokenrig.py)
- TokenRig's root code and published checkpoint card say MIT, but the embedded Michelangelo encoder
  requires a provenance audit against its original GPL terms. A top-level label is not a full-stack
  license audit. Keep evaluation isolated from bundled core code.
  [Root license](https://raw.githubusercontent.com/VAST-AI-Research/SkinTokens/main/LICENSE),
  [checkpoint card](https://huggingface.co/VAST-AI/SkinTokens),
  [original encoder license](https://raw.githubusercontent.com/NeuralCarver/Michelangelo/main/LICENSE)
- MIA v1 and v2 need separate pins. V2 directly loads `tencent/Hunyuan3D-2.1`, whose license
  excludes the EU, UK and South Korea; the outer MIT code / Apache-tagged MIA card does not remove
  that gate. Its Mixamo-derived template data also needs distinct redistribution clearance.
  [Backbone load](https://raw.githubusercontent.com/jasongzy/Make-It-Animatable/v2/model.py),
  [Hunyuan terms](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/LICENSE),
  [MIA dataset access](https://huggingface.co/datasets/jasongzy/Mixamo)
- Puppeteer's skin-only stage advertises 4.2 GB VRAM and an explicit supplied skeleton, but its
  required PartField dependency is non-commercial research/education only. It is not a default
  commercial-user option despite Apache licensing on the outer project. RigAnything is likewise
  research-only. These are exclusions from the product shortlist, not recommendations to install.
  [Puppeteer stage](https://raw.githubusercontent.com/Seed3D/Puppeteer/main/skinning/README.md),
  [PartField terms](https://raw.githubusercontent.com/ChaoyueSong/PartField/main/LICENSE),
  [RigAnything terms](https://raw.githubusercontent.com/Isabella98Liu/RigAnything/main/LICENSE.md)
- Classical heat, geodesic and bounded-biharmonic methods remain useful after the correct surfaces
  are identified. They do not infer whether a contacting surface is a hand or trousers. libigl's MPL
  and possible TetGen licensing also fall outside our current bundle allowlist. The previous
  donor/inpainting and voxel trials already establish that proximity plus smooth weights is not
  sufficient for this Amy input. [libigl license](https://libigl.github.io/license/),
  [bounded biharmonic method](https://homes.cs.washington.edu/~jovan/papers/jacobson-2011-bbw.pdf)

Independent TokenRig CPU/Vulkan and Rust/Metal ports exist, so future non-CUDA evaluation is
plausible. Their published small-asset results do not qualify our approximately 600k-vertex meshes.
The Rust executable explicitly documents GPL provenance; neither port is a cleared bundled
dependency. [CPU/Vulkan port](https://github.com/localai-org/skin-tokens.cpp),
[Metal/CPU port and provenance](https://github.com/chris-straka/skintokens)

## Blender can be automated without computer use

Blender exposes background execution and Python scripts. SpriteBook could invoke a controlled
script, read neutral arrays or candidate glTF, and show the result for acceptance. Opening Blender's
GUI would be an optional advanced escape hatch, not a requirement for the ordinary user.
[Official command-line source](https://raw.githubusercontent.com/blender/blender/v4.2.0/source/creator/creator_args.cc)

Three different operations should be kept explicit:

1. **Repair binding.** Identify body regions, constrain allowed influencing chains, fit a clean
   hidden body proxy, transfer reliable weights and solve uncertain boundaries. Blender's Data
   Transfer can copy vertex groups. Automatic weights remain a comparator: we already rejected a
   previous heat-binding trial on this asset.
   [Data Transfer](https://docs.blender.org/manual/en/4.3/modeling/modifiers/modify/data_transfer.html)
2. **Prepare and animate garments.** Confirm the garment selection; derive a simulation mesh from
   the actual surface; pin waist/cuffs; construct body colliders; simulate full clip time; transfer
   motion to retained render detail; correct and validate contacts on the final triangles. Blender's
   Surface Deform is specifically intended for a low-resolution cloth proxy driving a detailed mesh.
   Its bind target needs valid faces/edges and a good fit; distant or badly fitted surfaces can
   produce artifacts.
   [Surface Deform and constraints](https://docs.blender.org/manual/en/2.93/modeling/modifiers/deform/surface_deform.html)
3. **Repair topology when necessary.** Separate unintended bridges or create a clean proxy and
   transfer appearance. If the delivered surface must be remeshed, reproject textures and compare
   silhouettes. This changes geometry/UVs and needs an explicit reversible candidate, not a hidden
   "cleanup" that violates source preservation. Smoothing cannot detach one shared vertex into two
   independently moving surfaces. This is a proposed recovery policy, not a successful repair here.

The earlier Blender cloth trial used only 192 cage vertices. It reduced some contacts but lost
garment shape and left up to 10.1 mm source-detail penetration at the representative landing pose.
That is evidence against the coarse registration/transfer, not proof that Blender's cloth solver
cannot work. The next experiment needs a better actual-surface proxy and final-detail collision
coverage. Fewer colliding proxy vertices alone must not pass.

Blender is GPL software and is allowed here only at the existing optional external-process boundary.
Its license page distinguishes application licensing from artwork/output ownership. Distribution
still needs its own notices/source obligations; using a subprocess is an architectural choice, not
an automatic license clearance for every possible integration.
[Blender licensing and output](https://www.blender.org/about/license/?wvideo=akzb57a5z3)

## Other deformation and collision methods

| Method                                      | Useful for                                                          | Limit / recommendation                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better anatomical ownership constraints     | Hands near trousers, sleeves near torso, independent components     | Highest value for Amy. Use geometry and confident labels; offer a short brush/click disambiguation when uncertain.                                                                                |
| Dual-quaternion skinning / Preserve Volume  | Twist and volume loss around joints with otherwise sensible weights | Worth a later controlled comparison. It still follows wrong weights and does not provide garment contact. Both core and inspection must match.                                                    |
| Corrective smoothing / pose-space shapes    | Specific shoulder, elbow and knee shape problems                    | Good after ownership is sound. Correctives can be generated or authored, then sampled consistently; smoothing alone can erase detail.                                                             |
| Garment bones                               | Small skirts, coats and simple stylized secondary motion            | Compact and exportable, but need generated/edited weights plus pose-dependent control and collision. Adding bones alone is insufficient.                                                          |
| Offline cloth + detailed-surface correction | Skirts and loose outer garments over moving legs                    | Preferred Bulma investigation. Costs preprocessing time and needs garment/collider preparation; cache once per clip, not once per camera.                                                         |
| XPBD library                                | Lightweight compliant constraints and future tighter native control | MIT PositionBasedDynamics is a candidate if the existing Blender route proves too costly; integrating a solver does not remove preparation or transfer work.                                      |
| IPC / continuous collision                  | Stronger triangle/edge contact handling for an offline quality path | IPC Toolkit is MIT but explicitly not a full physics solver. C-IPC supplies research cloth code; documented builds target Ubuntu/macOS, not a qualified Windows package. Higher integration cost. |
| Hide fully covered body faces               | Removing invisible internal geometry                                | Optional authored optimization only. Re-check every pose/view; exposed knees, hem gaps and underside views can turn it into holes. Not our first generic fix.                                     |

Sources: [dual-quaternion method and limits](https://users.cs.utah.edu/~ladislav/dq/index.html),
[Blender Armature implementation](https://raw.githubusercontent.com/blender/blender/v4.2.0/source/blender/makesrna/intern/rna_modifier.cc),
[corrective pose workflow](https://help.autodesk.com/cloudhelp/2024/ENU/Maya-CharacterAnimation/files/GUID-B8755F24-7C24-4066-B6F8-2DE6954DC2BF.htm),
[PositionBasedDynamics](https://github.com/InteractiveComputerGraphics/PositionBasedDynamics),
[IPC Toolkit scope](https://github.com/ipc-sim/ipc-toolkit),
[C-IPC implementation](https://github.com/ipc-sim/Codim-IPC).

NvCloth is another established character-cloth solver, but its checked repository uses NVIDIA's
custom Source Code License rather than our bundle allowlist. Unreal/Houdini/Maya are valuable
workflow references, not proposed SpriteBook runtime dependencies.
[NvCloth scope](https://github.com/NVIDIAGameWorks/NvCloth),
[checked license](https://raw.githubusercontent.com/NVIDIAGameWorks/NvCloth/master/NvCloth/license.txt)

### A required core seam before importing Blender correctives

Core currently evaluates four-influence LBS. `packages/anim/profile.ts` deliberately skips morph
weight animation; `packages/anim/preview.ts` emits joint TRS; `packages/render/shaders.wgsl` blends
joint matrices without morph deformation. Therefore importing a Blender GLB with shape keys, or
enabling Preserve Volume only in Blender, would not automatically reproduce that output in Bake.

Choose one shared delivery path after the experiment succeeds: sampled corrective morphs with
explicit core support, or a versioned per-clip deformation cache that core renders and the viewer
plays. glTF morph displacements occur before skinning, so post-skin corrections require conversion
or a different cache representation. A Blender modifier stack is not a portable glTF cloth solver.
Do not change the renderer or canonical format merely to test a rejected correction.
[glTF skin/morph contract](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#skins)

At these vertex counts, dense position caches alone cost roughly 7 MB per frame per character,
before normals, tangents and metadata. A small garment-only or compressed cache is worth measuring;
do not materialize every clip's full-resolution deformation in memory. Canonical GLB export and an
animated correction export would also need separate, honest labels and provenance.

## Should we change animation libraries?

Distinguish **authored clips** from **the code that transfers/plays them**. We use Quaternius UAL
content and our own TypeScript retargeting. A new pack can supply a less exaggerated walk or jump,
but cannot repair arm-owned trouser vertices. First compare the same rig/weights under a procedural
single-joint diagnostic, a current clip and one independently authored motion. Check mapping, bind
axes, knee direction, root travel and contact numerically before blaming the pack.

UAL remains a useful CC0 source. Mesh2Motion is not necessarily an independent motion control,
because its ecosystem also uses Quaternius assets. Personal Mixamo import is a possible comparison,
but requires an explicit upload choice and separate terms review; it is not a local default or a
redistributable replacement pack. Adobe's own FAQ also requires recognizable clean humanoid parts
and a neutral pose, showing that another commercial auto-rigger still has input requirements.
[UAL publisher](https://quaternius.com/packs/universalanimationlibrary2.html),
[Mixamo requirements](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)

**ozz-animation** is a solid MIT C++ runtime for sampling, blending and animation tools across
Windows/macOS/Linux/WASM. It does not infer anatomy, repair weights or solve clothing. Adopting it
would add a native/WASM integration and a format seam without a demonstrated fix for these defects.
Keep it out of this repair scope unless a separate measured performance or runtime requirement
justifies it.
[Official scope, platforms and license](https://github.com/guillaumeblanc/ozz-animation)

Shape-aware motion adaptation is a later useful layer: preserve foot/hand contacts and adjust a pose
to a character's proportions or garment clearance with constrained IK. It changes the motion, so
measure deviations and expose the result as a candidate. Reducing a knee lift to hide a bad skirt is
not equivalent to repairing the skirt, and it must not silently weaken a requested jump.

## A simpler experience for ordinary users

Proposed workflow, preserving the six stages:

1. **Prepare for animation:** check upright/facing, limbs in contact, disconnected surfaces and
   likely garment regions. Recommend a separated A/T pose for new generation when feasible; retain
   original source and avoid silently reshaping an existing character.
2. **Fit and validate:** evaluate the chosen binder against a short arms-up, knee-bend, walk and
   jump set. Show the actual moving failure region, rather than asking users to interpret bone IDs
   and stretch ratios. Calibrate thresholds on known controls; do not invent a confidence score.
3. **Resolve ambiguity:** if needed, ask for a small number of outcome-oriented hints such as
   selecting the hand versus trousers, or confirming the loose skirt and fixed waistband. Keep
   expert weight painting and Blender behind an advanced action.
4. **Preview clothing:** compute one reusable clip result with progress, cancel and before/after
   playback. Cache keys include geometry, weights, selection, clip, solver/version and parameters.
   Store candidate changes reversibly; accept only after output checks.
5. **Bake validated motion:** the same deformation feeds flat preview and sheets. Camera changes
   reuse it. Unresolved cases remain explicit and recoverable, with an optional prepared `.blend`
   handoff for detailed edits and a checked candidate re-import.

Likely implementation reach if approved: registry/sidecar for an optional binder or Blender worker;
rig/schema for ownership and garment selections; animation for one shared deformation result;
render/pack for corrected positions, normals and full-clip bounds; Studio for guided selection and
review; model export for distinguishing canonical assets from baked deformation. No GUI-only solver.

## Bounded experiment plan and stop rules

| Experiment                 | Hold fixed                                                              | Evidence needed to continue                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TokenRig binder A/B        | Original render mesh, exact current joints/IBMs, clip and core renderer | Amy trousers stay with legs when arms rise; hands/cuffs remain intact; no new seam or silhouette damage. Qualify packed-weight loss and measured VRAM/time.                 |
| Independent motion control | Rig, weights, renderer                                                  | Source/reference and target angles/contact agree; identify whether only one authored clip or retarget rule is responsible. A different good-looking still is insufficient.  |
| Prepared Blender skirt     | Source render detail, clip timing, core camera/lighting                 | A fitted valid garment proxy, correct waistband, collision-free final-detail triangles throughout walk and all jump phases, acceptable strain/coverage and loop continuity. |
| Guided ownership fallback  | Same assets and quality gates                                           | A few surface hints resolve ambiguity without exposing a technical weight editor. If source topology must change, show and preserve that candidate separately.              |

Also run a clean authored control, a synthetic touching-limb case with known ownership, and
different-proportioned humanoids with trousers, skirts and coats. No character-name, texture-color
or hardcoded world-coordinate production rules. Preserve geometry/UV/texture bytes for a
weights-only repair, validate binding/seams, test actual surface contact, and compare core
preview/bake output.

Stop a candidate when contacts merely move elsewhere, garment coverage disappears, hands become
stretched, source detail is lost, or the solver fails. Do not keep tuning the same ambiguous mask
until one score turns green. The linked execution reports distinguish actual runs, rejected outputs
and provisioning blocks. No proposal or completed inference closes the existing motion gate.

## Cross-platform and footprint plan, 2026-10-23

The maintainer requests choices for weaker/stronger computers and other operating systems, with a
small default installation. This revises the evaluation order above. An accelerated method can win
on quality without becoming mandatory. A portable method must pass the same visual gate; low disk
use does not justify a broken rig. This is an isolated investigation; new providers remain
experimental, and the small compatibility correction is recorded separately in the CPU evaluation.

### Keep optional engines outside the base app

- Keep Blender, ML checkpoints and PyTorch/CUDA environments out of the default installer. Favor
  portable CPU methods that actually qualify. This does not promise CPU execution for existing heavy
  image-to-3D models or GPU rendering on an unsupported device.
- Prefer a qualified user-owned executable or already available compatible worker over a second
  engine install. Unregistering a user-owned tool must never uninstall it or delete its projects.
- If a repair needs an additional engine, show an explicit optional download with separate network,
  expanded runtime, weights, staging-peak and cache estimates. Do not install UniRig/PyTorch merely
  to obtain a CPU cloth engine. New Python tooling belongs in an isolated compatible environment.
- Reuse exact compatible package/cache contents where safe, without merging incompatible ML
  environments or altering global Python. Hard links affect actual disk use; report logical versus
  allocated sizes honestly. Remove abandoned stages and expose runtime/cache cleanup.
- Persist accepted weights and validated per-clip deformations in portable project artifacts. Camera
  changes reuse them without rerunning the tool. Mesh, rig, clip or solver changes invalidate that
  cache; preserve exact tool provenance and make updates reversible.

Read-only measurements on this checkout: Windows installer **64,255,482 bytes**; owned CLI resource
tree **306,803,375 logical bytes**; existing optional `bpy` 4.2 package **694,832,057 logical
bytes**, excluding Python and other dependencies. These measure different scopes, not total
installed-app size or newly allocated disk. Private report: `footprint-baseline.json` beside the
experiments.

### Blender deployment choices

| Choice                                                             | Additional engine footprint                                                          | Recommendation                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Compatible existing Blender executable in a new background process | No second Blender engine download/install; scripts, jobs and caches still cost space | Preferred optional path. Detect, test and record the chosen executable.                                         |
| Optional official portable Blender                                 | Hundreds of MB compressed plus expanded engine and caches                            | Offer only after a repair proves useful and the user chooses it. No file associations or global install needed. |
| Optional official `bpy` worker                                     | Large wheel plus matching Python, dependencies and expanded files                    | No GUI installation needed, but not automatically smaller overall. Avoid duplicating an existing engine.        |
| Custom headless/lite source build                                  | Unknown until built and measured                                                     | Not the first-beta default: substantial build/update/maintenance cost.                                          |

`--background` runs the normal Blender executable without its UI; it does not shrink the engine's
download or installed files. Blender exposes headless/lite source-build configurations, but no
separately supported small official prebuilt headless distribution was identified in this review.
[Argument implementation](https://raw.githubusercontent.com/blender/blender/blender-v4.5-release/source/creator/creator_args.cc),
[headless build preset](https://raw.githubusercontent.com/blender/blender/blender-v4.5-release/build_files/cmake/config/blender_headless.cmake)

Illustrative maintained LTS pin: Blender **4.5.15**. Compressed official package sizes in decimal
MB:

| Platform            | App archive / DMG | `bpy` wheel |
| ------------------- | ----------------: | ----------: |
| Windows x64         |         398.65 MB |   326.38 MB |
| Windows ARM64       |         254.75 MB |   193.67 MB |
| macOS Apple Silicon |         311.92 MB |   223.04 MB |
| macOS Intel         |         340.11 MB |   238.23 MB |
| Linux x64           |         378.04 MB |   372.77 MB |

These are download metadata, not expanded disk measurements or incremental costs after reuse. The
Linux wheel saves only about 5.27 MB compressed versus the app archive. Every listed 4.5.15 wheel
requires CPython 3.11; no Linux ARM64/musl wheel is listed. The newer 5.2.3 wheels require Python
3.13 and omit Intel Mac. Do not silently upgrade a worker across ABI/platform changes.
[Official archives](https://download.blender.org/release/Blender4.5/),
[4.5.15 wheel metadata](https://pypi.org/pypi/bpy/4.5.15/json),
[5.2.3 wheel metadata](https://pypi.org/pypi/bpy/5.2.3/json)

Use 4.2 only as retained experiment evidence; it reached upstream end of life in July 2026. A
maintained LTS and compatible newer releases need native smoke/quality checks before support.
[4.2 support window](https://www.blender.org/download/lts/4-2/),
[4.5 LTS](https://www.blender.org/releases/4-5/)

For existing-tool reuse, honor a saved user-selected executable, then a matching managed receipt,
PATH/bounded OS install locations and an explicit file picker. Resolve the actual executable and
probe it with a timeout in a **new background process**, using factory startup, automatic scripts
disabled and private job/config paths. Check version/build, architecture and the actual import,
armature/weight, cloth and output operations needed. A version string alone is insufficient. Do not
attach to the user's GUI, edit their preferences, install global add-ons or overwrite inputs. Record
tool changes, cancel only our workers, and independently validate artifacts. A subprocess isolation
boundary is not a complete OS sandbox or automatic licensing clearance.

### Compatibility work to reuse and improve

Extend the current registry gates, exact runtime recipes and configuration-specific memory admission
for methods that qualify; do not create a second model/install manager. Observed gaps:

- The former assumption that any `darwin` host means `macos-metal` is corrected locally: detection
  now reports CPU until the selected backend proves acceleration. Native Intel/Apple Silicon and
  actual Metal/MPS execution remain to be qualified. A renderer's Metal adapter does not establish a
  Python model's MPS support.
- Install-time VRAM advice reads total memory from the first NVIDIA GPU. Bind selected device,
  driver/kernel compatibility and memory availability to job-time admission; keep that separate from
  an install advisory. NVIDIA presence alone does not establish model support.
- Check actual OS/architecture, CPU requirements, available RAM, disk/staging budget and configured
  mesh limits. CPU recipes also need compatible native wheels/binaries. Distinguish unsupported,
  unmeasured and temporarily busy, rather than converting probe failures into a success.
- Preserve numerical kernel/output probes, explicit download/terms consent and cancellation. Never
  silently change backend, topology or output quality merely to fit the machine.

### Experiment and platform matrix

| Method family                                       | Comparison to run                                                                              | Product position if it passes                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| CPU geometric / guided / donor binding              | Existing baseline, Mesh2Motion-style method and anatomy-constrained transfer on touching limbs | Candidate small portable base path.                                                         |
| DQS / corrective deformation                        | Same weights/poses under LBS versus volume preservation and smoothing/shapes                   | Small method footprint, but requires core/viewer parity.                                    |
| Blender automatic weights / Rigify                  | Alternative binding with controlled placement; fitted control-rig workflow separately          | Optional existing-tool route; controls do not solve garment contact.                        |
| Compact cloth constraints / XPBD                    | Confirmed garment, valid rest surface, body contact and final-detail transfer                  | Potential smaller CPU garment path. Measure before adopting a physics stack.                |
| Blender cloth                                       | Same garment/clip, fitted proxy, final-detail contact, shape and loop continuity               | Optional reference/advanced quality path; measure reused versus managed runtime costs.      |
| TokenRig official and viable CPU/Metal/Vulkan ports | Fixed exact skeleton and full sequences; dependency/kernel/terms screening                     | Optional acceleration or optional portable tool if total cost/quality justify it.           |
| MIA v1 and permitted v2 configurations              | Independent full rig/pose reset and core retarget comparison                                   | Optional after template/dependency/territory screening.                                     |
| Independent motion control                          | Controlled poses and source/reference versus target and another motion                         | Determine clip/retarget faults before replacing the pack/runtime.                           |
| IPC / advanced contact                              | Escalate if prepared simpler methods still fail                                                | Screen full solver/platform/dependency cost first; IPC Toolkit alone is not a cloth solver. |

Puppeteer/PartField and RigAnything remain screened out from the commercial-user shortlist under
their checked terms. Don't install every research stack to tick a box. Reuse prior negative results
and rerun only when ownership, registration or another relevant input changes.

Execution targets: Windows x64 CPU-only paths and current NVIDIA hardware; macOS ARM64 and Intel
CPU/tool execution separately; Linux x64 CPU plus actual supported accelerators; Windows ARM64 with
native binaries. Linux ARM64 stays unqualified for providers without a matching distribution.
Metal/MPS, AMD/Intel GPU and lower-VRAM NVIDIA performance require real available devices, not an OS
label or mocked capability report.

GitHub-hosted OS jobs can exercise CPU tools, public fixture correctness and failure recovery. They
do not establish consumer GPU performance. Verify runner availability and architecture before
publishing a matrix; accelerated Mac/GPU access remains a separate gate. Public CI must not upload
the private Amy/Bulma assets. Constrained-memory workers and mocked reports test admission/recovery,
not the speed or support of a physical weaker GPU.
[Runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

For every viable candidate, record full-sequence ownership, final-triangle contact, strain/volume,
silhouette/detail, seams and temporal continuity before comparing speed. Then measure cold/warm
time, peak RAM/VRAM, download bytes, expanded runtime, staging/cache growth, base-app size delta,
cancellation and removal. Use small/medium/full meshes and the same quality gates on every machine.

The approved local comparisons now have separate execution reports linked above. Next, resolve
surface ownership with a guided/source-preparation candidate and qualify final-detail garment motion
before promoting a provider. Deployment, clean install, cancellation/removal and native CI lanes
follow only for a useful candidate. The research itself establishes no release or new native
platform support. The later maintainer approval permits a capture/export preview with documented
motion limitations; see [the release checklist](beta-0.5.md). Blender deployment remains the
maintainer's later decision.
