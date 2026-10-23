# Humanoid weights and garment clearance

Research and isolated CPU spike, 2026-10-22. This is an implementation recommendation, not a claim
that every generated humanoid can be repaired automatically.

## Recommendation

Investigate the bundled CC0 humanoid as a **hidden weight donor**, warped to the predicted skeleton.
Transfer reliable weights onto the generated mesh, then fill uncertain areas along its own topology.
Keep the generated positions, normals, triangle order, UVs and textures. Qualify this as a repair
candidate, against the existing rig, before promoting it. Treat skirt/knee clearance as a separate,
motion-dependent correction; changing static weights cannot promise collision-free clothing.

This fits the existing TypeScript/Node core and NumPy/SciPy sidecar. It needs no additional model,
CUDA job or native compiler. The source asset publisher describes the Universal Base Characters as
animation-ready humanoids, compatible with the Universal Animation Library, under CC0. The
repository already bundles male and female bodies, with their own manifest and license evidence.
[Quaternius source](https://quaternius.com/packs/universalbasecharacters.html),
[bundled female manifest](../packages/rig/bodies/ubc-female/body.json)

## What is actually broken

The retained Amy raw prediction assigns over 80% arm influence to 818 of 836 samples in a measured
outer-trouser area. This is already present before SpriteBook transfers weights back to its original
mesh. The saved aligned mesh has 595,107 vertices and 28 predicted joints. Skeleton alignment and
normalized weight sums do not establish correct surface ownership. The earlier distance, normal,
visibility and Blender heat experiments did not produce a safe replacement. Local evidence:
`.render-bench/amy-rig/weight-ownership.json` and the replay artifacts beside it.

Bulma has a different visible failure: an animated leg can cross the skirt. A correct joint tree and
smooth skin weights still do not supply garment contact. Keep both acceptance cases: arms rising
away from trousers, and a knee rising beneath a skirt. A single count of bend warnings cannot
replace them. See the existing [Amy follow-through in F5-T2](roadmap.md).

## Why donor transfer is a better next experiment

Epic's SIGGRAPH Asia 2023 method transfers weights only at confident body/garment correspondences,
then inpaints the rest. Its reported problem includes nearby but unrelated parts receiving each
other's weights, including crotches and loose garments. This directly matches the ownership failure.
[Author project and abstract](https://www.dgp.toronto.edu/~rinat/projects/RobustSkinWeightsTransfer/)

The paper assumes aligned meshes. It accepts a closest-surface match using distance and normal
agreement, copies barycentrically interpolated weights at those anchors, and minimizes combined
Dirichlet/Laplacian energy elsewhere. Its reference thresholds are 5% of bounding-box diagonal and
35 degrees. The solve uses `Q = -L + L M^-1 L`, constrained at anchors; small negative values are
clamped and rows renormalized. A component without any anchor needs an explicit recovery policy.
These thresholds are starting points, not qualifications for SpriteBook's generated geometry.
[Paper, sections 3.1–3.3](https://www.dgp.toronto.edu/~rinat/projects/RobustSkinWeightsTransfer/preprint.pdf)

The authors' sample code is MIT, but requires libigl and Polyscope. Do not introduce those just for
this repair: reproduce the small numerical formulation using installed NumPy/SciPy, and reuse the
core's glTF readers and nearest-triangle arithmetic. Preserve attribution if copying code.
[Source repository](https://github.com/rin-23/RobustSkinWeightsTransferCode),
[MIT terms](https://raw.githubusercontent.com/rin-23/RobustSkinWeightsTransferCode/main/LICENSE)

### Small implementation boundary

1. Read the existing canonical body and predicted rig. Map named humanoid chains; map absent donor
   digits to their nearest known ancestor, and report the loss of independent finger motion.
2. Warp only the donor: align each named donor bone to the target bone, scale its length, and blend
   its affine transforms using the donor's authored weights. Match head/torso proportions before
   trusting surface correspondence. Do not project the donor onto a nearby unrelated body part.
3. Find donor triangle correspondences for original target vertices. Accept anchors only when
   distance, normals and anatomy agree. Reject competing hand/leg correspondences near contact;
   uncertain vertices belong in the solve, not in the fixed anchor set.
4. Weld exact-position duplicates in the **temporary solve topology**, so texture seams cannot
   receive different weights. Connect only authored triangle edges; never create nearest-neighbor
   links between an adjacent hand and trouser leg. Scatter results back to original vertex order.
5. Factor the unknown submatrix once and solve each active joint column. Clamp numerical negatives,
   normalize, pack four influences using the existing conventions, and revalidate seam continuity
   and edge stretch. SciPy supplies reusable sparse factorization; a larger solve can use a checked
   iterative method with a recorded residual and convergence status.
   [SciPy factorized](https://docs.scipy.org/doc/scipy/reference/generated/scipy.sparse.linalg.factorized.html),
   [SciPy CG contract](https://docs.scipy.org/doc/scipy/reference/generated/scipy.sparse.linalg.cg.html)
6. Write neutral candidate weights, apply them through core, run bend checks and standard animation
   poses, then compare with the current rig. Preserve the old rig for undo and keep refusal/recovery
   honest when the donor is a bad fit.

The existing `fitCanonicalBody` is useful reference code, but is not this operation: Track A changes
the delivered surface to the canonical body's topology. Calling it as a fallback would discard the
very character detail and texture layout this repair must retain.
[Existing fit contract](../packages/rig/fit.ts)

## Isolated CPU spike

The ignored `.render-bench/beta-0.5/garment-research/` contains the source dump, donor warp,
transfer script and neutral candidate weights. No live workspace, production module or GPU runtime
is modified. It uses the bundled female donor and the already aligned Amy copy, plus a read-only
dump of the saved Bulma mesh.

The first nearest-vertex pass on Amy reduced mean arm ownership in a skeleton-relative lower-trouser
probe from 82.54% to 0.000337%, and vertices above 80% arm influence from 11,130 to zero out of
14,830. That pass had one nonconverged joint solve. The refined pass uses barycentric interpolation
over the 16 nearest donor face centroids and excludes anchorless components from the solve: 38.79%
of welded Amy vertices become anchors, all joint solves converge, and the probe mean becomes
0.000248% with zero vertices above 80%. Runtime was about 31 seconds on this machine, CPU only.

These are diagnostic samples, not a hand-labeled trouser segmentation or a visual quality grade.
There are 6,237 welded Amy vertices in components with no confident anchor; the spike explicitly
uses nearest donor weights there. It also uses a positive graph harmonic energy rather than the
paper's full cotangent/biharmonic energy. The face-centroid shortlist is approximate. Do not promote
these candidates solely because the ownership probe improves: inspect hands, head, crotch, elbows,
skirt and silhouette through walk, jump and raised-arm poses.

Bulma's refined pass uses 40.75% anchors, has 1,157 anchorless welded vertices and converges in
about 29 seconds. Its comparable lower-body probe already has zero arm leakage, which stays
effectively zero. Core applies both candidate files successfully. Exact assertions confirm
preservation of all original non-skin geometry attributes, triangle indices and texture bytes.
Core-generated walk, T-pose and jump-start/loop/land previews are saved beside the candidates.
Remaining bend flags include real limb-boundary stretch as well as expected uninfluential unnamed
finger joints: the unqualified donor candidates should not replace working rigs wholesale.

A narrower hybrid keeps existing weights except where the donor strongly favors lower-body joints
and the current rig favors arms. It changes some weights on 85,917 Amy vertices, with 33,165
receiving the full donor correction, and changes no Bulma vertices. The selection uses named body
regions, not character coordinates. Amy's same probe drops from 82.54% mean arm ownership to 0.623%,
with no vertices above 80%. Its bend report retains three stretch findings at Amy's hand/fused
finger chain and one uninfluential digit; it avoids introducing whole-body donor stretch elsewhere.
`candidate-hybrid.glb` and `workspace-hybrid/anim/` contain that candidate and its standard motion
previews. **Visual review rejected this hybrid:** Amy's raised-arm pose still shows jacket wings,
and hands stretch toward the legs. The inferred lower-body selector also includes nearby actual
hands. The lower-trouser numerical probe therefore understates the defect. This candidate is not
beta-ready and must not be promoted. A successful selective repair needs reliable region ownership
and full-character motion checks, rather than selecting from the same ambiguous proximity alone. The
full smoothed donor candidate also fails that visual review: trousers improve, but the jacket flares
like a cape and hands stretch diagonally toward the hips. All donor candidates remain unqualified.
Investigate donor registration and hand/cuff correspondence before changing more thresholds or
attempting promotion.

Replay from the repository root, using the already installed sidecar environment:

```powershell
node .render-bench/beta-0.5/garment-research/dump.mjs
sidecar/.venv/Scripts/python.exe -X utf8 .render-bench/beta-0.5/garment-research/transfer.py
sidecar/.venv/Scripts/python.exe -X utf8 .render-bench/beta-0.5/garment-research/smooth.py
sidecar/.venv/Scripts/python.exe -X utf8 .render-bench/beta-0.5/garment-research/hybrid.py
node .render-bench/beta-0.5/garment-research/apply.mjs -hybrid
node .render-bench/beta-0.5/garment-research/previews.mjs -hybrid
```

These private scripts contain local source locations and are deliberately untracked. The research
document records the method without publishing those locations. Candidate paths for each character
are `.render-bench/beta-0.5/garment-research/{amy,bulma}/candidate-hybrid.glb` and
`candidate-smooth.glb`; neutral weights use the same stems with `.npz`. `deform-hybrid/` and
`deform-smooth/` contain core reports. The hybrid preview directory contains
`preview-{walk-loop,a-tpose,jump-start,jump-loop,jump-land}.glb`.

## Skirt/knee clearance needs a distinct step

Linear blend skinning combines joint transforms; it does not solve contact. glTF represents skinning
and animated morph weights, but does not define a runtime cloth solver. A UI-only displacement would
also break SpriteBook's preview/bake parity.
[glTF skin and morph contracts](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#skins)

For the beta, use a small, explicit **garment clearance mask** and kinematic leg proxies, rather
than a full cloth simulator. Infer a mask only when an isolated skirt surface is clear; offer
selection when generated geometry is fused or ambiguous. Build thigh/knee/calf capsules from the
skeleton and measured skin surface; keep a thin safety margin. After skinning, push masked cloth
vertices outside the proxies, smooth the correction along garment edges, pin the waist, and bound
the maximum change. Check triangles as well as vertices: a capsule can pass through the middle of a
large triangle even when its corners are outside.

This proposal borrows the position-projection idea, not an entire physics engine. Position Based
Dynamics projects positions onto collision constraints and combines them with internal constraints;
the original paper demonstrates cloth and explains why correcting positions gives direct control.
[Original PBD paper](https://matthias-research.github.io/pages/publications/posBasedDyn.pdf)

Implement the correction in shared core pose evaluation. Inspection must play its produced clip or
corrected mesh, and both preview and bake must consume exactly the same result. A static
pose-dependent clearance pass is easier to seek and reproduce than history-dependent simulation. If
correction is exported as glTF morph animation, account for glTF's morph-before-skin order;
world-space pushes cannot simply be written as rest-space morph deltas. Refuse singular inversion
and retain a safe fallback. Do not hide the knee, remove body triangles or alter the animation just
to conceal the failure.

Limits: capsules approximate anatomy, masks can be wrong, large kicks may need an artist-authored
corrective, and this does not add fabric drape, self-collision, multilayer ordering or dynamics.
Start with walk and jump; avoid claiming collision-free arbitrary motion.

### CPU clearance experiment: refused

The isolated clearance probe measures radial surface width along the thighs relative to measured
calf radius. It requires an outward flare followed by a radius drop above the knee, then feathers a
lower-garment mask and pins its waist. This is deliberately narrow: an unfitted or ambiguous shape
gets no automatic correction. It uses named anatomy to locate bones, but no character-name, color,
or per-character coordinate exceptions. Amy has no qualifying flare and receives zero masked
vertices. Bulma has 76,484 welded vertices in the inferred region, 52,169 with strong mask
confidence; the inferred hem is at 60% of the hip-to-knee interval. This recognizes these two
examples, not all skirts, trousers, coats or dresses.

The probe samples 17 poses each from core-retargeted walk, jump-start, jump-loop and jump-land
clips. It projects masked surface vertices outside moving thigh/calf capsules, then smooths the
correction over authored edges. A second trial adds edge-length constraints and fixed boundary
vertices. Neither trial changes the animation, removes triangles, hides legs, or replaces the mesh.
The control uses the same geometry without any clearance adjustment.

At the worst jump-land sample, 3,051 confident vertices penetrate the proxy. Projection reduces this
to 32, but creates substantial local stretch. The bounded edge-constraint trial leaves 47
penetrating vertices and reduces penetrating face-centroid samples from 5,736 to 251. Its largest
posed correction is 45.6 mm; the corresponding rest-space morph reaches 79.5 mm. Relative to the
uncorrected skinned surface, the 99th-percentile edge stretch is still 2.04×, with a worst edge near
96.8×. The result therefore fails the explicit 1.25× P99 guard and is **refused**. Improving a
contact counter while introducing stretched surface patches is not acceptable.

The glTF order is handled explicitly: each posed correction is converted by the inverse of its
vertex's blended skin 3×3 matrix. Determinant below `1e-5` or condition number above 100 refuses a
moved vertex. This sample has no singular moved vertices. Independent core `skinAll` evaluation of
the float32 rest morph reconstructs the desired posed displacement within `1e-6` m.
Duplicate-position vertices use one temporary solve position, and re-evaluating all original skin
rows bounds their correction discrepancy near `1e-8` m. Exact comparisons preserve all original base
geometry attributes, triangle indices, UVs and texture bytes; only a new morph target and a static
posed joint state are added to the diagnostic comparison GLB.

Private replay and artifacts:

```powershell
node .render-bench/beta-0.5/garment-research/garment-poses.mjs
sidecar/.venv/Scripts/python.exe -X utf8 .render-bench/beta-0.5/garment-research/clearance.py
sidecar/.venv/Scripts/python.exe -X utf8 .render-bench/beta-0.5/garment-research/clearance.py --edges
node .render-bench/beta-0.5/garment-research/clearance-artifacts.mjs
```

`{amy,bulma}/clearance/mask.json` records classification and uncertainty. Bulma's `report.json`
contains the full sampled cycle checks; `report-edge.json` contains the bounded follow-up on the
worst initial sample. `before-clearance.glb` and `refused-clearance-edge.glb` show that static pose
without and with the refused corrective. `worst-edge-rest-delta.bin` and
`worst-edge-posed-delta.bin` record both spaces. All files remain under the ignored research folder.

Conclusion: inverse-skin correction and a conservative no-skirt control are practical on CPU. This
simple mask/capsule solver is not a generic skirt repair. It still needs reliable garment
boundaries, better constraint propagation, and a collision test over whole triangles rather than
sampled points. Before production work, inspect the refused artifact to distinguish proxy overreach,
an incorrect mask, and insufficient cloth freedom. Keep the existing animation intact; do not
silently accept the distorted result or weaken the surface-quality guard.

The full 68-pose pass takes about 89 seconds on CPU. Its independent seam reconstruction error is
below `1e-8` m across all samples; no moved blend matrix is singular. The table counts contact
observations across all 17 samples per clip, not unique vertices across the animation:

| Clip       | Confident vertex contacts before → after | Frames refused for surface distortion | Worst P99 edge ratio |
| ---------- | ---------------------------------------- | ------------------------------------- | -------------------- |
| Walk       | 2,831 → 0                                | 0 of 17                               | 1.18×                |
| Jump start | 8,491 → 67                               | 2 of 17                               | 2.29×                |
| Jump loop  | 3,564 → 0                                | 0 of 17                               | 1.13×                |
| Jump land  | 19,155 → 291                             | 8 of 17                               | 2.30×                |

Walking and the airborne loop are numerically more tractable than takeoff/landing, but are not
visually qualified or proven collision-free: proxies and sampled centroids can miss actual triangle
contact. The static comparison artifact carries only a POSITION morph; its displaced shading normals
are not separately corrected. It is a diagnostic geometry view, not a polished animation export.

### Coherent-field and uncorrupted-base follow-up

The next isolated trials keep every original animation track and validation guard. A pelvis-radial
trial computes outward directions in the rest XZ plane, rotates them by the posed pelvis, finds
capsule ray exits, and smooths a nonnegative scalar displacement field over the mesh. It fails the
same landing pose: a direction can become nearly parallel to the raised thigh, requiring 257.5 mm of
movement and producing 6.93× P99 edge stretch. Smooth directions alone do not solve contact.

An 8-height by 24-angle polar cage permits both outward and upward motion. Bilinear interpolation
spreads its corrections over the original vertices; a small regularized least-squares system fits
capsule projection targets. On the existing LBS base it leaves 839 confident vertex contacts, with
48.8 mm maximum movement and 1.95× P99 relative stretch. This candidate is also refused.

The original landing surface itself has a 3.38× P99 edge ratio relative to its undeformed mesh,
before any contact correction. The cage trial ends at 3.44×. Therefore local contact is being solved
on top of an already heavily distorted garment. A subsequent trial first blends the inferred skirt
toward pelvis-rigid motion, adds rest-length constraints, and then fits the cage. Initial capsule
contacts drop from 3,051 on the old LBS surface to 188 on this base, but the geometric mask's hem
transition creates its own distortion: the final P99/rest ratio reaches 5.00×. Total movement versus
the old LBS surface reaches 297.3 mm; cage-only movement reaches 101.8 mm. This remains refused.

Private replay uses `clearance-radial.py`, `clearance-cage.py` and `clearance-rigid.py` in the same
ignored folder. Each checks the existing worst landing sample; `--all` requests all 68 poses.
`clearance-artifacts.mjs radial`, `cage` or `rigid` emits static before/refused GLBs for review.
`report-{radial,cage,rigid}.json` and `worst-{radial,cage,rigid}.json` contain the measurements. The
independent morph-before-skin and base-attribute assertions still pass for these artifacts.

A topology check narrows the next hypothesis: cutting the mesh graph below the upper fifth of the
thighs separates substantial outer/back skirt components from components reaching the calves and
feet. About 1,583 vertices in the original geometric "skirt" mask instead belong to a foot-reaching
component. Thus the mask includes some leg surface and unnecessarily feathers a genuinely free
garment hem. This does not establish that the entire skirt is fused to the legs. The next mask
should anchor those skirt-only lower components, reject calf-reaching components, and transition
only near the waist; the evidence does not justify treating every loose-looking vertex as cloth.

That topology-anchored mask selects two lower garment components containing 48,659 vertices, then
solves a harmonic transition through 55,641 waist-band unknowns. The solve converges. With the
pelvis-rigid base and a rest-length-constrained polar cage, the worst landing P99/rest edge ratio
improves from 3.18× on its old LBS surface to 1.55×. However, 1,352 confident vertices and 2,402
face centroids still penetrate the proxy; total correction versus old LBS reaches 304.9 mm.
Cage-only movement is 31.1 mm. The unchanged guards still refuse the result. This is evidence for
improving the mask and base together, not a successful generic corrective.

Replay this separate branch with `clearance-topology.py`; its mask, report and before/refused
artifact use `topology` in their filenames. The geometric mask and original contact trials remain
preserved.

An incremental cage projection variant accumulates smoothed control updates instead of shrinking the
whole cage toward zero every iteration. After 400 iterations, confident contacts fall further to 401
vertices and 616 face centroids, but P99/rest rises to 2.50× and cage-only movement to 112.5 mm.
This also fails. `clearance-topology-step.py`, `report-topology-step.json` and
`refused-clearance-topology-step.glb` preserve that negative result. There are still no singular
moved blend matrices; original-row seam reconstruction stays below `6e-8` m. Neither additional
iterations nor a coherent control cage resolve the contact/strain tradeoff on these settings. No
branch is promoted, no validation threshold is relaxed, and no production or live character file is
modified.

### Existing Blender cloth solver spike, 2026-10-23

The installed isolated UniRig environment contains `bpy` 4.2.0, including its CPU cloth solver. A
disposable subprocess successfully simulates a 192-vertex, 168-quad polar skirt cage with pinned
waist, pelvis motion, gravity, self-collision and four animated thigh/calf capsule colliders. The
cage starts from its own fitted rest geometry, not from the corrupted LBS cloth shape. Twenty settle
frames and 30 rest-to-pose approach frames precede the 17 core jump-land samples. Effective scene
FPS matches the clip sample timing. Only neutral NumPy arrays cross the subprocess boundary.
Blender's source defines the exposed pinning, stiffness and collision settings; its cloth update
transforms pinned positions through the object transform and keeps dynamic rest-shape updates
separately gated.
[Blender 4.2 cloth settings source](https://raw.githubusercontent.com/blender/blender/blender-v4.2-release/source/blender/makesrna/intern/rna_cloth.cc),
[Cloth update source](https://raw.githubusercontent.com/blender/blender/blender-v4.2-release/source/blender/blenkernel/intern/cloth.cc)

Both tested configurations finish with finite output: a moderate material in 4.6 seconds, and a
lighter/stiffer material in 16.7 seconds. The latter uses quality 60, collision quality 12, vertex
mass 0.001 kg, tension/compression/shear stiffness 5,000 and bending stiffness 100. No additional
wheel, compiler or GPU job is involved. These settings are an isolated calibration experiment, not
defaults proposed for the application.

The simulated cage offsets are bilinearly transferred through the topology-anchored garment mask, on
a pelvis-rigid base; original source details remain as offsets from the cage. At the worst
unadjusted-contact sample (jump-land frame 5), the stiffer trial reduces confident source-vertex
contacts from 8,231 to 167 and source face-centroid contacts from 16,075 to 310. Its source P99/rest
edge ratio improves from 2.91× to 1.86×. Nevertheless, penetration reaches 10.1 mm there, total
movement versus old LBS reaches 310 mm, and all 17 source poses remain refused. Across the full
sequence, summed source contacts fall from 72,231 to 6,302, while the worst source P99/rest remains
2.20×.

The cage has no penetrating sampled vertices at that worst frame, but its own P99 edge ratio is
1.41×; the sequence maximum reaches 1.96×. A collision-free coarse vertex set does not establish
collision-free faces or collision-free retained source detail. Waist pin error peaks at 3.64 mm in
the stiffer trial. Inverse blended-skin reconstruction stays finite with no singular moved matrices;
source seam discrepancy at the representative frame is below `4e-8` m. Geometry/UV/texture
preservation and independent morph-before-skin artifact assertions continue to pass.

Private replay, from the repository root:

```powershell
sidecar/.venv/Scripts/python.exe -X utf8 .render-bench/beta-0.5/garment-research/cloth-prepare.py
# Run cloth-bpy.py in the already installed UniRig Python, in a disposable subprocess:
$savedRun = Get-Content .render-bench/amy-rig/workspace/rig/rig-run.json -Raw | ConvertFrom-Json
$unirigPython = $savedRun.unirigPython
& $unirigPython -X utf8 .render-bench/beta-0.5/garment-research/cloth-bpy.py --stiff
sidecar/.venv/Scripts/python.exe -X utf8 .render-bench/beta-0.5/garment-research/cloth-analyze.py --stiff
node .render-bench/beta-0.5/garment-research/clearance-artifacts.mjs bpy-stiff
node .render-bench/beta-0.5/garment-research/cloth-cage-artifact.mjs
```

Resolve `$unirigPython` from the existing installed runtime receipt; the private preparation scripts
and reports retain exact local paths. The research doc deliberately does not publish a developer's
profile location. `bulma/clearance/cloth/` contains neutral input/output arrays and solver settings.
`report-bpy-stiff.json`, `refused-clearance-bpy-stiff.glb` and `cage-simulation-bpy-stiff.glb`
contain measurements and static geometry for review. Omitting `--stiff` reproduces the preserved
moderate material trial and its `bpy` artifacts.

Result: the existing solver is callable and fast enough for a small CPU research cage, but this
configuration/transfer does not meet the surface-quality or clearance gates. It does not justify
adding a cloth subsystem to production. Further work would need better garment registration,
collision coverage and a validated transfer of retained source detail; changing the physics engine
alone has not solved those problems. No candidate is promoted and validation thresholds stay intact.

## UniRig checks worth keeping separate

Upstream's skin transform normalizes to `[-1,1]`, derives voxel skin weights on a 196-cell grid, and
samples a mixture of surface and vertex points. Its affine transform includes mesh and joint bounds
and uses one maximum extent, so vertices and joints must share one transform. Higher voxel
resolution is suggested upstream, but is a memory/quality experiment rather than a proven repair.
[Inference skin configuration](https://raw.githubusercontent.com/VAST-AI-Research/UniRig/main/configs/transform/inference_skin_transform.yaml),
[Affine normalization source](https://raw.githubusercontent.com/VAST-AI-Research/UniRig/main/src/data/augment.py)

The voxel prior independently normalizes mesh and joints together. The prediction then combines
learned point/bone features with voxel skin, builds an ancestor-propagated mask and normalizes its
masked output. Inspect the retained voxel prior in the leaking trouser region before trying another
GPU seed. A wrong prior/ownership neighborhood is not fixed by a row-sum repair. The training code
includes posed-vertex loss through linear blend skinning, which is not a collision constraint.
[Voxel prior code](https://raw.githubusercontent.com/VAST-AI-Research/UniRig/main/src/data/vertex_group.py),
[Skin inference and training code](https://github.com/VAST-AI-Research/UniRig/blob/main/src/model/unirig_skin.py)

## Acceptance before shipping

The final root review also rejected the Blender cage visually: fewer proxy contacts did not preserve
the skirt's shape or coverage. The correction is not suitable for production.

An independent UniRig voxel-prior trial completed in 8.5 seconds. Its joints align with the
canonical rig within `6e-8` metres, but its transferred weights still pull trousers with raised
arms. A distance-only semantic-bone trial also fails. Neither numerical normalization nor a correct
joint order establishes anatomical surface ownership.

The Amy contact probe compared the original indexed graph, a position-welded graph and a graph
joined only through matched manifold edges. UV chart fragmentation makes the original graph alone
inconclusive. Even the manifold-edge graph connects 5,288 of 5,543 sampled lower-hand points to a
calf-reaching component below the wrist cut; 3,228 remain connected at a lower finger-level cut.
Texture color selected these diagnostic samples only; it is not a production classifier or a general
hand-segmentation claim. The next repair must distinguish contacting surfaces and genuine seams
before choosing weights, rather than assuming that every nearby point belongs to one limb. Private
replays are `amy-contacts.py`, `edge-weld.py` and `amy-indexed-contacts.log` under the beta proof
directory.

- Amy: trousers remain with the legs when both arms rise; hands do not drag head, coat or trousers.
- Bulma: knee and skirt remain separated through an entire walk and jump, in side and elevated
  views.
- Add one synthetic contacting-limbs case with known donor ownership; test changed pose and scale,
  rather than encoding Amy-specific coordinate bands in production.
- Preserve all original geometry/UV/texture bytes; validate finite normalized weights, packed
  indices, seam continuity, bind-pose roundtrip, and checked solver convergence.
- Reproduce the same selected corrected pose in core preview and bake. Review temporal continuity
  over every frame, not just the worst-looking still.
- Keep unresolved regions explicit. Do not silently replace the character with the donor, relax bend
  thresholds, or market a static clearance corrective as general cloth simulation.
