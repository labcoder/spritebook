# Prepared garment reference: attachment and motion gates

2026-10-23, approved first-character hardening milestone. **A complete walk-and-jump
prepared-garment reference is not qualified.** The independent authored body now has a walking
garment that passes sampled geometry/coverage checks and a separately validated periodic walking
cache. The deep takeoff/landing poses still expose incompatible attachments or damaged cloth. These
findings do not qualify Bulma, generated clothing, automatic Blender correction or a production
vertex cache.

All experiments use the retained optional Blender 4.5.15 LTS Windows executable. Nothing was
installed, no production provider was changed and no live character was modified. See the
[maintained Blender trial](maintained-blender-trial.md) for its distribution and licensing record.

## Defects isolated in the earlier controls

The earlier “authored control” authored the skirt geometry but drove it with Bulma's predicted
skeleton and approximate leg capsules. It was not an independent authored-character control. Its
fixed waist pins enter those capsules by 19 mm during takeoff and 50 mm during landing. No cloth
solver can simultaneously obey those fixed positions and keep the same colliders clear. The old
driver also advanced at only 6.4–12.6 Hz, with joint-position steps up to 282 mm.

Dense core sampling and a feasible higher waist remove the capsule contacts, but adding an explicit
torso exposes self-crossings and coverage loss. More collision iterations, a graded pelvis-pinned
collar and 120 Hz sampling do not establish a clean jump. A result that passes only the leg capsules
must not pass the full body gate.

Blender keeps pin targets in world space and advances its point cache from the preceding frame; the
maintained source also defines mass per vertex. Correct ownership, time steps and feasible
constraints are part of the experiment, not evidence that the solver repaired the input.
[Cloth implementation](https://raw.githubusercontent.com/blender/blender/blender-v4.5-release/source/blender/blenkernel/intern/cloth.cc),
[settings definitions](https://raw.githubusercontent.com/blender/blender/blender-v4.5-release/source/blender/makesrna/intern/rna_cloth.cc)

## Independent authored body and actual attachment

The second control uses the preserved, imported CC0 Universal Base Characters reference: 8,213
canonical vertices, 14,318 triangles and 65 authored joints. Every collision frame comes from the
same core-retargeted walk/takeoff/air/landing previews. Blender's evaluated body must match those
frozen positions within 2 micrometers. The source body, source weights, clips and textures remain
unchanged. The separate experimental skirt has 1,536 vertices and 2,944 triangles.
[Source character pack](https://quaternius.com/packs/universalbasecharacters.html),
[glTF skinning specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#skins)

A naive conical fit already crossed 134 body triangles at rest. The revised preparation fits outside
the complete body, checks the retained triangles, and attaches each waist point to a reviewed source
triangle using barycentric position plus a rotating triangle-frame offset. Interpolated skin weights
alone did not preserve the offset through torso bending.

Preparation now refuses incompatible inputs before simulation. On this body/landing clip, waist
heights 1.08 m and 1.12 m fail; a separately authored high-waist garment at 1.16 m has at least 8 mm
of pin clearance over landing. That changes the reference garment design; it is not an automatic
alteration or repair of an existing user's skirt. Takeoff still makes the same regular loft's
attachments enter neighboring body surfaces, so that attempt refuses before solving.

## Independent final-surface checks

All recorded final garment triangles are checked against the complete posed body, with separate
nonadjacent garment self-crossing checks. Keep the prior P99 edge/rest limit of 1.25; require no new
collapsed surface (P01 triangle area/rest at least 0.25), correct attachment and zero missing
coverage probes. Coverage consists of 192 explicitly selected body points under the garment,
following the actual source triangles, with outward rays that must hit the garment.

These are discrete checks. Strict noncoplanar triangle crossings exclude touching, coplanar and some
containment cases; they are not continuous collision certification. Counts below sum observations
over time, not unique bad triangles. Loop endpoint measurements remove pelvis motion and do not
certify whole-body root continuity or shared production preview/bake playback.

| Authored-body skirt trial                     | Samples | Body crossings | Self-crossings | Worst P99 edge/rest | Most missing coverage probes | Verdict                                    |
| --------------------------------------------- | ------: | -------------: | -------------: | ------------------: | ---------------------------: | ------------------------------------------ |
| Naive fit/weight-offset landing               |      77 |            348 |          8,272 |               1.533 |                           53 | Invalid rest fit; rejected                 |
| Exact attachment/fitted high-waist landing    |      77 |              0 |            403 |               1.316 |                           13 | Rejected                                   |
| Higher quality/larger self-distance landing   |      77 |              0 |            576 |               1.437 |                           14 | Rejected                                   |
| Soft rest-shape tethers, landing              |      77 |         10,035 |          3,692 |               2.362 |                            6 | Rejected                                   |
| Four-times slower quasi-static drive, landing |      77 |              0 |            174 |               1.311 |                           15 | Rejected                                   |
| Regular smooth loft, landing                  |      77 |              0 |            529 |               1.240 |                           14 | Rejected despite passing strain            |
| Fitted walking skirt, three cycles            |     244 |              0 |              0 |               1.033 |                            0 | Geometry passes; raw loop mismatch remains |
| Reviewed periodic walking cache               |      82 |              0 |              0 |               1.027 |                            0 | Sampled gates pass; reference only         |
| Regular loft, airborne loop, two cycles       |     301 |              0 |              0 |               1.060 |                            0 | Geometry passes; raw loop mismatch remains |
| Regular loft, takeoff                         |       — |              — |              — |                   — |                            — | Refused: 160 incompatible pin observations |

The quasi-static trial slows only the solver's kinematic drive and retains the original core
animation times in its output; it does not replace or shorten the character clip. It still fails.
The soft tethers are spring goals, not a proven hard maximum-distance implementation. Do not
repackage either rejection as a working industry cloth method.

The walking loop needs explicit cache authoring. Three raw cycles leave a 31.2 mm P99 mismatch. A
smooth blend between consecutive equal-phase cycles changes cloth by at most 52.9 mm and closes the
endpoint within 0.00006 mm after float serialization. Its seam velocity difference is 0.866 times
the interior P99 difference. All 82 resulting frames still pass body/self/coverage and shape checks.
Core-rendered front/side samples show a coherent walking skirt. This is an authored periodic
correction, not natural simulation convergence or a shipped cache format. A whole-cycle Hermite
closure attempted on the earlier capsule control required a 116 mm correction and was rejected
rather than accepted merely because its endpoints matched.

## Cost, evidence and remaining gate

Workers are sequential CPU simulations with owned process trees, a hard 180-second timeout and two
Blender threads. Later workers also enforce a 2 GiB job-commit limit and sample the owned working
set. Completed independent-body solves take about 31–99 seconds and observed peak working sets about
321–502 MB on this Windows host; these are concurrent-session observations, not minimum hardware
requirements or isolated benchmarks. The walking source solve takes 53.5 seconds; independent
checking takes 8.3 seconds. No solve requests CUDA.

The new private replay root is `.render-bench/garment-reference-hardening-2026-10-23/`:

- `audit-input.py` and `input-audit.json`: earlier control/pin/time-step diagnosis.
- `dump-authored.mjs`, `authored-motion/`: preserved authored body and dense core drivers.
- `simulate-authored.py`, `run.py`: bounded preparation and solve; each case retains its config,
  preflight, process report, frozen neutral arrays and simulation report.
- `evaluate-authored.py`, `check.py`: independent complete-body, self, shape and coverage checks.
- `crossfade-loop.py`: reviewed periodic candidate; `authored-safe-walk-crossfade/result.npz` is the
  passing walking reference array, not a live workspace replacement.
- `proof-authored/`: core-rendered snapshots retaining source appearance, owned render report and
  `authored-reference-diagnostics.png`. Early capsule proofs remain separately labeled.

The current useful next step is a feasible art-directed garment/pose contract: validate actual
attachments across the selected motions, then author bounded corrective poses or choose a compatible
garment/motion variant. Source preparation must keep anatomical ownership and complete collision
coverage. More solver switches or blanket knee masking are not justified. Production cache
integration still needs shared animation preview/bake consumption, interpolation, bounds,
deterministic identity, disk budgets and export semantics after a whole useful motion set passes.
Blender remains optional. Native Mac/Linux, weaker hardware, continuous collision, fresh-machine
preparation and arbitrary generated garments were not qualified here.

## Separate upper-back cape: bounded comparison

The approved follow-up changes the attachment contract: a separate, authored open-back cape on the
same preserved CC0 body. It does not qualify skirts, generated garments or Bulma. The final pattern
has 896 vertices, 1,674 triangles and a 1.34 m hem width on the 1.82 m body. Ninety-six selected
upper-back points share one source-triangle orthonormal frame, preserving their rest offsets without
inheriting the source skin's local stretching. Complete body geometry remains the collider; clips
and anatomical weights remain unchanged.

The earlier narrow panel was already missing eight of the declared 192 back-coverage rays at rest.
Small wing extensions still missed two; preparation now rejects them before solving. Independently
skin-attached pin points stretched the attachment patch by more than 50% during landing. A rigid
patch avoids that particular defect. Another harness mismatch used solver quads but separately
split/reversed output triangles; the final comparison feeds the **same explicit triangles** to
solver and independent evaluator. None of these corrections alone qualifies cloth.

The final four-clip comparison freezes one configuration: quality 40, bending 5, 6 mm self-distance,
25 mm authored back offset, rigid attachment frame, full-body collision and unchanged 192 actual
source-triangle back probes. All four input preflights have zero rest body crossings, zero rest
coverage misses and feasible attachments: minimum pin clearance is 12.8 mm walking, 19.4 mm takeoff,
20.6 mm airborne and 21.4 mm landing. No threshold was loosened.

| Final cape trial            | Samples | Body crossings | Self-crossings | Worst P99 edge/rest | Most missing back probes | Verdict                                       |
| --------------------------- | ------: | -------------: | -------------: | ------------------: | -----------------------: | --------------------------------------------- |
| Walking, two cycles         |     163 |              0 |              0 |               1.235 |                       20 | Rejected: coverage and raw periodicity        |
| Takeoff                     |      82 |              0 |              0 |               1.232 |                        4 | Rejected: coverage                            |
| Airborne, two cycles        |       — |              — |              — |                   — |                        — | 180 s timeout; unqualified                    |
| Landing                     |      77 |              0 |            601 |               1.330 |                       64 | Rejected: self-crossings, strain and coverage |
| Periodic walking correction |      82 |              0 |              0 |               1.229 |                        6 | Rejected despite matching endpoints           |

The periodic walking correction closes endpoints but changes the cloth by up to 327 mm and still
misses six coverage rays. It is rejected. A closed loop or zero body intersections cannot replace
coverage, shape and temporal checks. These negative results apply to this bounded preparation and
solver configuration; they do not establish that an artist cannot author a working Blender cape or
that Blender's cloth solver is inherently incapable.

Completed final solves take 93.6 s takeoff, 106.6 s landing and 133.6 s walking, with observed peak
working sets 302, 297 and 365 MB respectively. The airborne loop reaches the hard 180 s limit at 397
MB; its owned process tree is terminated and no final output is accepted. Completed independent
checks take 3.0–5.5 s, about 198–208 MB observed working set. Earlier cape solves are 20.2–79.7 s,
291–417 MB, and rejected preparation checks about 2–3 s; `cape-all-costs.json` retains every saved
solve/check/audit process record. The core proof renders 25 snapshots / 75 images in 8.0 s, about
343 MB observed working set. Concurrent GPU use makes that diagnostic timing non-qualifying as a
performance benchmark. No CUDA solve or added install is required. These are host observations, not
weaker-hardware or native-platform guarantees.

The attachment audit records canonical source triangle 4884 (vertices 1070, 2849, 2850), its
barycentric center, every pinned vertex and bounds. Final output pin errors reach 0.15 mm walking,
2.68 mm takeoff and 2.16 mm landing; feasible targets do not mean perfectly rigid solver pins. Core
rear/side images confirm the landing panel folding and riding upward. The periodic walking sheet is
calmer but still fails the fixed coverage requirement.

Private replay adds `simulate-cape.py`, `cape-protocol.json`, `cape-reference-*/config.json`,
`cape-summary.json`, `cape-attachment-review/attachment.json` and `proof-cape/` under the same
private root. Completed cases retain neutral `result.npz` arrays and independent `evaluation.json`;
timeout logs remain failures without fabricated measurements. Proof sheets include actual core
front/side/rear renders, source appearance and labeled failing frames. The replay uses `run.py` and
`check.py` with a case name, using the existing sidecar Python to launch the retained Blender.

The adoption gate remains open. The next useful experiment needs an art-reviewed garment/motion
contract and a specified coverage-preserving corrective method, rather than another blind solver
sweep. Require a complete walk/takeoff/air/landing set, periodic output and full independent
geometry/coverage checks before production cache/provider integration. Current evidence supports
keeping Blender optional and refusing unsupported garment repair honestly.
