# Humanoid weights and garment clearance

Research and isolated CPU spike, 2026-10-22. This is an implementation recommendation, not a claim
that every generated humanoid can be repaired automatically.

## Recommendation

Use the bundled CC0 humanoid as a **hidden weight donor**, warped to the predicted skeleton.
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
previews. This selective repair is the preferred beta experiment: keep known-good surfaces and use
the donor to challenge obvious cross-body-part ownership, rather than replacing every weight.

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
