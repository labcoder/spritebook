# Binding and garment attachment follow-up

2026-10-23, F5-T2/F6-T1. This follows the approved
[guided motion repair trials](guided-motion-repair.md). All character candidates stayed in private
research copies. **Neither candidate qualifies for automatic use.** No production binder, cloth
provider, source topology, live project, model dependency or animation clip was changed.

## What changed in the experiment

The binding trial includes hands, sleeve cuffs and trousers in one ownership solve. The garment
trial preserves the actual detailed source boundary instead of treating a pinned proxy waist as
proof that the dense garment is attached correctly. These address preparation failures before
another solver or cache integration.

Private scripts, artifacts, source hashes and replay evidence are under
`.render-bench/binding-clothing-followup-2026-10-23/`. No private model or reference image is
included in the repository or CI. The separate
[maintained Blender evaluation](maintained-blender-trial.md) records the optional engine trial.

## Hands, cuffs and trousers

The same 595,107-render-vertex Amy source is retained with all 799,985 triangles, textures, UVs,
normals, node transforms, hierarchy, skin order and inverse binds. These attributes are checked
again after candidate GLB serialization. Exact coincident render seams share the same weights and
remain coincident at all 85 measured poses.

The new private, reviewed color/position seeds distinguish body, left hand/cuff and right hand/cuff.
Color contrast assists propagation along authored triangle edges. It never adds nearest-position
connections between touching surfaces and never picks a nearest bone as a missing reference. This is
guided source selection, **not automatic anatomical segmentation**. Texture/shadow and geometry
rules specific to this investigation are not production defaults.

Compared with the earlier low-height ownership split, including the cuffs avoids intentionally
treating every low sleeve point as torso. The same-owner harmonic fill has 77,337 body anchors and
fills 55,458 uncertain welded body positions. All selected arm positions already have sufficient
retained arm influence. However, seven body components containing 3,268 welded positions have no
trustworthy same-owner anchors. Those positions are left unchanged and reported; the candidate does
not silently substitute donor or nearest-bone weights.

The complete source is tested at 17 frozen samples each for walk, jump start, jump loop, jump land
and raised arms. The measurement includes 1,376,756 unique source edges with rest length above 1.1
micrometres, with no upper-length or selected-region filter.

| Clip        | Original worst per-frame P99 edge/rest | Candidate |
| ----------- | -------------------------------------: | --------: |
| Walk        |                                 2.646× |    1.388× |
| Jump start  |                                 4.464× |    2.236× |
| Jump loop   |                                 4.008× |    1.965× |
| Jump land   |                                 3.785× |    1.972× |
| Raised arms |                                 5.635× |    1.880× |

Core renders cover five poses per clip from front and side, using those same serialized weights.
They still show skin tethers and jacket wings as the arms rise. The reduced trouser motion does not
establish correct hand/cuff separation or whole-character quality. **Reject the candidate.** The
seven unanchored components remain an explicit refusal condition for an automatic repair.

The unchanged generic solver's controls were replayed in an isolated output directory: independent
sheets 1 mm apart retain separation; conflicting owners and anchorless surfaces refuse. A clean CC0
authored character retains motion within 0.00009 mm. A deliberately corrupted thigh patch's
0.724–1.111 m motion error falls to 8.98–12.39 mm across 65 samples of each walk/jump clip. These
controls validate the known-region primitive, not the private selector or automatic repair.

## Detailed garment attachment

The retained Bulma garment has 81,003 diagnostic vertices and 163,557 original triangles. Its
boundary with the unchanged source contains 1,290 edges and 640 selected boundary vertices. These
boundaries span roughly Y=0.563–0.648 m: they are not equivalent to the proxy's single top ring.

The follow-up measures distance from that actual boundary through the selected source triangle
graph. A reviewed 30 mm smooth transfer collar blends between original skin motion at the boundary
and the prior simulated detailed garment in the interior. Every selected component reaches a real
attachment boundary. All 640 boundary positions follow original skin motion; 8,760 other positions
receive a partial blend and 71,603 receive the complete simulated transfer. No source triangles,
body faces, pockets or interior detail are deleted. No hidden body geometry is invented.

This is a continuity experiment on the retained simulation output, not a new cloth solver. It does
not make layer correspondence, rest collisions or body coverage valid. The boundary continuity
result is useful, but it must be judged with the entire garment.

| Clip       | Prior boundary P99/rest | Collar boundary P99/rest | Collar garment P99/rest | Strict actual-body crossing observations |
| ---------- | ----------------------: | -----------------------: | ----------------------: | ---------------------------------------: |
| Walk       |                  17.39× |                   1.154× |                  3.835× |                                   31,592 |
| Jump start |                  37.09× |                   1.216× |                  6.210× |                                   12,682 |
| Jump loop  |                  20.66× |                   1.079× |                  5.066× |                                   68,619 |
| Jump land  |                  50.10× |                   1.214× |                  6.496× |                                   82,569 |

Each row covers 17 poses and every retained detailed triangle. All four clips still fail the
unchanged shape/contact gates. The walking loop retains 72.94 mm P99 endpoint mismatch after
removing pelvis motion; the airborne loop retains 23.31 mm. Fixed-camera core images show a more
continuous waist but a visibly crumpled, collapsed skirt and lost coverage during landing. **Reject
this candidate as well.**

Nonadjacent detailed self-crossing observations are 611,218 for walking, 5,465,277 for jump start,
1,776,498 for the airborne loop and 8,067,122 for landing. Their original-LBS counterparts are
125,323, 217,737, 148,188 and 218,953. Keeping the waist attached does not rescue the interior
surface; all four completed checks make that visible failure measurable.

The independent final-triangle crossing validator runs in the maintained portable Blender 4.5.15
process. It uses a BVH broad phase and separate segment/triangle interior tests, with crossing and
separated controls. It checks the final detailed garment against the 105,381 selected actual body
triangles and against nonadjacent detailed garment triangles. Counts sum observations over time, not
unique triangles. The selected actual body still lacks complete hidden upper-thigh coverage;
touching/coplanar contacts and full containment are outside this test. Positive crossings suffice to
reject a result; zero alone would not establish safety. This is sampled validation, not continuous
collision certification.

## Next useful work

Keep the current core motion path and the shipping limitation. Do not deploy a deformation cache or
offer an automatic repaired-candidate acceptance button for either failed result.

The next source-preparation workflow needs reviewed complete part ownership or an explicit suitable
reference. It should show the selected hands, cuffs and trousers together, list unresolved
components, and refuse when an owner has no trustworthy anchors. A color-assisted selector may help
a human make that selection; it cannot certify it. Legitimate cuffs and erroneous fused hand/trouser
connections must be distinguished before any explicit topology edit.

For clothing, retain an actual source-boundary attachment contract like the collar experiment, then
require an unambiguous exterior carrier/detail correspondence and reviewed body collider coverage. A
proxy waist that is pinned correctly cannot certify a dense multilayer garment. Shape,
final-triangle contact, coverage, seams and loop state all remain gates. Increasing iterations or
replacing the animation player does not address the demonstrated source preparation failures.

Workers are limited to 180 seconds and 2 GiB observed process-tree working set, with file-backed
logs. The app bundle adds no solver/model/runtime bytes for these experiments. Workload costs
overlap other approved trials and are not minimum hardware requirements or isolated benchmarks.
Native Mac/Linux/ARM, weaker GPUs and continuous motion collision were not qualified here.
