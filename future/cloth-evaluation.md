# Garment motion: CPU constraints and Blender evaluation

Investigation dated 2026-10-23. This records the approved experiments from
[animation-quality-options.md](animation-quality-options.md). Research artifacts are private,
ignored files; no cloth solver, model installation or live character was changed. Choosing or
deploying Blender remains a maintainer decision.

**Recommendation: do not ship either experimental garment path.** The small CPU solver completes,
and a lower-cost Blender simulation completes, but both damage the retained skirt and leave
collisions. Blender Surface Deform preserves the rest surface very accurately; that does not make
the animated result safe. A prepared garment layer, attachment loop and fitted body colliders are
the next useful inputs. More iterations on the same inferred shell are not a qualified repair.

## What was compared

The earlier [garment research](garment-skinning-research.md) rejected capsule pushes, radial pushes,
rigid-pelvis projections and a coarse 192-vertex polar cage. Those negative results stand. This
experiment instead starts from the retained source garment in its undamaged rest pose, fits a much
denser proxy to the actual surface and compares two detail-transfer methods. The original animation
and original skin weights are held fixed.

The retained Bulma copy has 628,916 render vertices and 799,996 triangles. Exact-position welding
produces 397,828 diagnostic vertices. An existing, topology-reviewed private garment mask supplies
81,003 vertices and 163,557 original triangles in one connected component. This supplied mask
isolates solver evaluation; it is **not evidence of automatic garment recognition**. Amy was not
modified by this experiment. No new Amy garment-control run was performed; earlier non-skirt mask
and ownership failures remain relevant rather than silently counting as a passed control.

Three completed comparisons use the same four leg capsules, pelvis-following waist pins and core
`jump-land` joint trajectories:

1. **CPU XPBD-style constraints and triangle detail transfer.** NumPy applies area-derived masses,
   9,024 rest-length constraints and 8,832 opposite-vertex bending-distance constraints, in 14
   nonoverlapping constraint groups. Each frame uses eight substeps and twelve iterations. The
   distance constraint uses compliance and accumulated multipliers; this is a compact experimental
   approximation, with no dihedral material model or self-collision. The XPBD paper motivates the
   compliance formulation; it does not validate this implementation or its collision treatment.
   [XPBD paper](https://matthias-research.github.io/pages/publications/XPBD.pdf)
2. **The same CPU proxy motion with Blender Surface Deform.** This holds cloth motion identical and
   changes only the transfer to retained source detail. It is a transfer comparator, **not a Blender
   cloth simulation**.
3. **Blender cloth and Surface Deform.** Installed isolated `bpy` 4.2.0 supplies cloth,
   self-collision and detail transfer. The completed lane uses cloth quality 5 and collision
   quality 3. A separate quality-40 / collision-quality-10 lane was stopped without completed pose
   arrays. Neither result qualifies a newer Blender runtime or another platform.

Both solvers start from rest, settle for 20 frames, approach the first clip pose over 30 frames and
then produce all 17 sampled clip frames. Pins follow the pelvis; the cloth rest shape is not the
already-distorted LBS skirt. Four thigh/calf capsule colliders follow core poses. Capsule sizes are
retained private measurement inputs, not a production character classifier. Collision safety
thickness totals 6 mm in the experiment.

## Proxy preparation and the actual boundary

Directly decimating the actual garment to 3,257 vertices / 5,999 triangles gave a close rest fit,
but the proxy contained 107 components and 112 boundary groups after proxy-only nonmanifold cleanup.
It was rejected as a cloth sheet. A connected source component and an accepted Surface Deform bind
were insufficient topology checks. The retained render geometry was never decimated or cleaned.

The solver comparison therefore uses a **3,072-vertex / 5,952-triangle source-fitted shell**, with
32 height rings and 96 angular samples. Every sample ray hits the actual source garment. It has one
sheet, two boundary loops, no nonmanifold edges and 96 waist pins. This is more detailed and better
fitted than the rejected coarse cage, but still assumes a star-shaped skirt around the pelvis.
Multiple layers, pockets and overhangs make that correspondence ambiguous.

Both outermost-hit and innermost-hit shells were prepared. The innermost shell was used for the
completed comparisons to put most retained detail outside the collision carrier. Its source-to-
proxy distance has median 5.96 mm, P99 20.82 mm and maximum 26.36 mm. Signed normal detail offsets
range from -3.87 mm to +26.36 mm. Thus even this fitted proxy is not an exact garment layer. Those
offsets can rotate or fold into a body collider when the proxy bends.

Surface Deform bound successfully and reconstructs the retained garment at rest within 0.000483 mm
maximum error. Its source checks require valid target geometry, and its bind is a geometric
deformation mapping; it is not a collision solver for the detailed output. Our inference is that
rest reconstruction, target topology and animated detail safety need separate gates.
[Surface Deform implementation](https://raw.githubusercontent.com/blender/blender/blender-v4.2-release/source/blender/modifiers/intern/MOD_surfacedeform.cc)

Blender's cloth settings expose pin groups, collision thickness, self-collision and solver quality;
its implementation separately updates rest data and animated constraints. The experiment keeps
dynamic rest-shape updates disabled and moves the object/pins with the pelvis. These are relevant
controls, not a claim that a settings change alone repairs this garment.
[Cloth settings](https://raw.githubusercontent.com/blender/blender/blender-v4.2-release/source/blender/makesrna/intern/rna_cloth.cc),
[cloth update implementation](https://raw.githubusercontent.com/blender/blender/blender-v4.2-release/source/blender/blenkernel/intern/cloth.cc)

## Final render-surface results

Every completed result was tested on **all 163,557 retained garment triangles at all 17 output
frames**, rather than merely checking proxy vertices. The independent evaluator computes finite
capsule-segment to triangle distance, including segment/triangle crossings and edge distances.
Contacts deeper than 1 mm count as failures. A triangle touching several capsules can contribute
several contacts; the table sums those contacts across time and is not a unique-triangle count. The
anatomical capsules are approximate; this is not proof against actual posed body triangles.

The shape gate requires per-frame P99 edge length / rest edge length at most 1.25. Existing tiny
edges below one millionth of character height are excluded from this strain statistic, with the same
filter for every comparison. Zero contact failures and acceptable shape are both required. The
original LBS baseline already reaches 3.32× P99/rest strain in this clip.

| Candidate                                | Summed final capsule contacts | Worst final P99/rest strain | Worst proxy P99/rest strain | Outcome               |
| ---------------------------------------- | ----------------------------: | --------------------------: | --------------------------: | --------------------- |
| Original LBS baseline                    |                       245,776 |                       3.32× |                           — | Existing defect       |
| CPU XPBD + triangle transfer             |                       157,706 |                       7.31× |                       1.86× | Rejected              |
| Same XPBD motion + Surface Deform        |                       156,132 |                       5.76× |                       1.86× | Rejected              |
| Blender cloth quality 5 + Surface Deform |                        98,362 |                      10.08× |                       2.52× | Rejected              |
| Blender cloth quality 40                 |               No final arrays |               Not evaluated |               Not evaluated | Stopped during warmup |

The completed Blender lane has fewer contacts largely while the skirt crumples toward the hips. The
CPU lanes also fold/stretch the retained garment badly. All completed candidates fail both contact
and shape gates. Lower contact counts do not establish useful cloth, and the high-quality timeout is
not evidence that Blender cloth in general cannot solve a properly prepared garment.

The diagnostic frame at 0.158 s was rendered through SpriteBook's core shader from the full retained
model, front and side, with a shared fixed camera and pixel crop. The four-column comparison shows
the baseline, CPU transfer, CPU + Surface Deform, and Blender cloth. All three experimental columns
are visually rejected. Private image: `cloth/proof/cloth-comparison.png` under the replay root
below. The render snapshots intentionally freeze posed positions and recompute normals; they are
proof assets, not replacement canonical meshes or an implemented cloth preview/export path.

## Geometry, seams and glTF safety

The static candidate morph artifacts retain the exact original base positions, triangles, UVs, skin
attributes and texture bytes, verified after a GLB write/read. Only the supplied garment region
receives corrective displacement; vertices outside it remain unchanged. Coincident source seams
receive identical displacements through the exact-position source map. That guarantees continuity
for those exact duplicates, **not** nearby seams, layer ownership or strain continuity at the mask
boundary.

For the three diagnostic candidates, posed displacement is converted back through the inverse
blended skin 3×3 before writing a rest-space morph. The proof refuses singular blends. The sampled
minimum singular value is 0.601, maximum condition number 1.665, and core skinning reconstructs the
requested posed displacement within 0.000050 mm. This respects glTF's morph-before-skin ordering; it
proves the coordinate conversion, not acceptable deformation.
[glTF morph and skin specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#meshes-morph-targets)

Movement is also unacceptable: maximum posed movement from original LBS over the clip is 369 mm for
CPU transfer, 368 mm for CPU + Surface Deform, and 269 mm for Blender cloth, on a 1.1 m tall
canonical character. The static diagnostic frame needs rest-space morph deltas up to 321 mm for the
CPU candidates and 240 mm for Blender cloth. Those are warning measurements, not permissible
production limits. No candidate is saved to a live workspace or offered for acceptance.

## Measured CPU and storage cost

These are single local Windows runs, not cross-platform benchmarks or isolated FPS measurements. The
subprocess meter samples the owned process tree every 25 ms and sums CPU time across observed
processes. Other approved research was running during parts of the evaluation. RSS is the maximum
concurrent working set of that process tree; MB below means 1,000,000 bytes.

| Operation                                               | Wall time |   CPU time | Peak RSS |
| ------------------------------------------------------- | --------: | ---------: | -------: |
| Build source-fitted inner shell and bind Surface Deform |    2.63 s |     3.06 s |   448 MB |
| CPU XPBD, 67 simulation frames + 17 detail outputs      |   35.73 s |    31.28 s |   122 MB |
| Surface Deform transfer of the saved CPU motion         |   16.13 s |    22.45 s |   630 MB |
| Blender cloth quality 5, full sequence + detail         |   14.14 s |    64.91 s |   715 MB |
| Blender cloth quality 40, stopped at warmup frame 40/67 |  801.90 s | 4,600.05 s |   920 MB |
| Independent full CPU-transfer triangle evaluation       |   83.95 s |    71.81 s |   107 MB |
| Independent CPU + Surface Deform triangle evaluation    |   34.01 s |    30.02 s |   104 MB |
| Independent Blender cloth triangle evaluation           |   36.82 s |    36.50 s |   107 MB |

The high-quality lane exceeded the planned ten-minute bound before its owned worker was stopped;
context/tool delay made the observed duration 13m22s. Subsequent workers have a hard owned-process-
tree timeout of 180 seconds. The completed lower-cost simulation did not time out. Evaluation times
differ because identical baseline/proxy checks were reused where exact proxy-array equality was
asserted, and because the early CPU evaluation overlapped the expensive Blender worker.

No new runtime was downloaded or installed. The existing `bpy` package alone occupies 694.8 MB; that
excludes Python, other packages and portable Blender. The fitted-shell `.blend` bind cache is 89.21
MB, neutral proxy mapping is 5.66 MB, shared retained input is 56.45 MB, and each saved 17-frame
proxy + retained-garment result is 17.15 MB. Preparation is not fully portable merely because the
CPU solve uses NumPy: these proxy/bind experiments still use Blender. Fresh-versus- cached repeat
timing, animation loop settling, cache invalidation and other operating systems were not qualified.
Application bundle-size increase is zero because nothing was integrated.

## Next useful experiment and minimal guided input

Keep the current binder and retargeting path while exposing the garment limitation honestly. The
bounded experiments did not establish an automatic fix for arbitrary generated clothing. Do not
replace body geometry, hide knees, shorten clips, or silently accept the crumpled result.

The next meaningful garment experiment needs:

1. **One coherent selected cloth layer.** Distinguish the intended outer skirt from inner faces,
   pockets, body and attachments. A region mask alone does not supply that correspondence.
2. **A confirmed attachment loop and free hem.** Fit a rest shell to that selected layer and reject
   disconnected, folded or ambiguous proxy mappings before simulation. Preserve source detail as a
   separate render surface.
3. **Reviewed colliders.** Fit to actual posed thighs/knees, and reject initial overlaps or
   impossible pin/collider configurations. Body coverage and proxy coverage need separate checks.
4. **Full final-surface qualification.** Validate the transferred triangles against the actual posed
   body, near-seam continuity, rest strain, self-intersection, loop seams and visible cloth shape
   across walk/jump. Any additional correction must be bounded and reversible.

A short guided selection/preparation step is a credible next direction; it is not yet implemented or
proven sufficient. A newer optional Blender may be useful for that authoring path, but these results
do not justify making it mandatory. A compact CPU path also needs robust cloth collision, bending
and detail correspondence beyond the prototype. Neither should be promoted on this data. The source
Blender components are GPL; using the already-installed isolated runtime for research does not
change the repository's permissive bundle policy or settle a deployment decision.
[Blender component license](https://raw.githubusercontent.com/blender/blender/blender-v4.2-release/source/blender/modifiers/intern/MOD_surfacedeform.cc)

The subsequent [prepared-garment trials](guided-motion-repair.md) extend this comparison to a clean
authored control, improved exterior carrier and full walk/jump samples. They retain all detailed
garment triangles and add actual-body/self-crossing/loop checks. Neither actual-character candidate
passes; this report's negative verdict is unchanged.

## Private replay and artifacts

Replay root: `.render-bench/quality-research-2026-10-23/cloth/`. Scripts only write there. The
retained input copy is `.render-bench/beta-0.5/garment-research/bulma/`; no live workspace is read.
Set `$clothPython` to the existing isolated Python containing `bpy`, and `$basePython` to the
existing sidecar NumPy/SciPy Python. This is not an installer or a command to mutate a user's
character.

```powershell
$clothRoot = '.render-bench/quality-research-2026-10-23/cloth'
& $basePython -X utf8 "$clothRoot/prepare.py"
& $clothPython -X utf8 "$clothRoot/proxy-chart-bpy.py" --inner
& $basePython -X utf8 "$clothRoot/xpbd.py" jump-land chart-inner
& $clothPython -X utf8 "$clothRoot/transfer-sd-bpy.py" jump-land chart-inner
& $basePython -X utf8 "$clothRoot/meter.py" "$clothRoot/chart-inner/bpy-fast-jump-land-meter.json" --timeout=180 $clothPython -X utf8 "$clothRoot/simulate-bpy-fast.py" jump-land chart-inner
& $basePython -X utf8 "$clothRoot/evaluate.py" xpbd jump-land chart-inner
& $basePython -X utf8 "$clothRoot/evaluate.py" xpbd-sd jump-land chart-inner
& $basePython -X utf8 "$clothRoot/evaluate.py" bpy-fast jump-land chart-inner
& $basePython -X utf8 "$clothRoot/proof-input.py"
$env:SPRITEBOOK_GPU_BACKEND = 'vulkan'
.build/runtime/node.exe "$clothRoot/proof.mjs"
& $basePython -X utf8 "$clothRoot/summarize.py"
```

Reports: `summary.json`, `chart-inner/*-evaluation.json` and `*-meter.json`. Neutral completed
outputs: `chart-inner/{xpbd,xpbd-sd,bpy-fast}-jump-land.npz`. Static rejected morphs and posed GLBs:
`proof/{xpbd,xpbd-sd,bpy-fast}-refused-morph.glb` and `proof/*-snapshot.glb`. Labeled proof image:
`proof/cloth-comparison.png`. No final arrays exist for the stopped high-quality Blender lane. Only
the critical landing case was taken through this final-surface comparison; walk, loop seams, Amy and
other garments do not gain a pass by implication.
