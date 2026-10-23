# CPU binding, deformation and motion evaluation

Evaluated locally on Windows x64, 2026-10-23. These are disposable comparisons, not new integrated
riggers. Live projects, model environments and source meshes remain unchanged. No new dependency is
added to the application or its lockfile.

**Recommendation:** retain the current binder while developing explicit surface ownership and
garment preparation. Neither a fast geometric binder nor volume-preserving skinning repairs the
observed failures automatically. Keep Blender optional and undecided. The
[TokenRig evaluation](tokenrig-evaluation.md) and [cloth evaluation](cloth-evaluation.md) cover the
parallel comparisons; [the proposal](animation-quality-options.md) records deployment choices.

The [guided follow-through](guided-motion-repair.md) now tests explicit-region harmonic fill,
conservative mesh separation and public controls. Clean/control results improve, but the actual Amy
selection still fails or refuses. No new automatic binder is integrated.

## Controls and boundaries

- Full generated meshes: aligned Amy, 595,107 vertices / 28 joints; Bulma, 628,916 / 52.
- Authored CC0 female body: 8,844 vertices / 65 joints. Normal, tall and short/chunky humanoid
  skeleton fixtures add proportion controls for motion transfer.
- Hold original geometry, UVs, textures, joint transforms, inverse binds and animation fixed during
  weights-only comparisons. Candidate GLBs assert these properties after serialization. The
  Mesh2Motion joint traversal is mapped explicitly back to the input skin order by unique names.
- Compare walk-loop, jump-start, jump-loop and jump-land at 17 poses each. These 68 samples are not
  continuous collision detection. The independent motion control samples 65 poses per clip.
- Edge length relative to rest and coincident-position seam disagreement are diagnostics. A low
  percentile cannot establish correct surface ownership, garment coverage or absence of triangle
  contact. Review textured front/side captures alongside numbers.

Private replay scripts, binary inputs, per-frame reports and candidate meshes are under
`.render-bench/quality-research-2026-10-23/cpu/`. Textured core captures are under the sibling
`tokenrig/visual/`. Private characters are not public CI fixtures.

## Exact upstream CPU binder

The unmodified Mesh2Motion `SkinningAlgorithm` at commit `653a9698f5f315523072f1c3ff3496100401317b`
was bundled for this experiment with the already installed Three.js dependency. Only its required
source graph was fetched: 85,702 bytes including its README. This is a source size, not a measured
shipping bundle delta. No complete web app, animation pack or new runtime was installed. Upstream
states MIT for code and CC0 for art; a standalone distribution still needs a pinned notice and
component audit.
[Pinned source](https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/src/lib/solvers/SkinningAlgorithm.ts),
[project terms](https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/README.md)

| Input                            | Solver time | Peak process RSS | Result                                                            |
| -------------------------------- | ----------: | ---------------: | ----------------------------------------------------------------- |
| Authored control                 |     0.088 s |         77.3 MiB | Finite normalized weights; motion differs from authored skin      |
| Amy                              |     2.155 s |        699.5 MiB | Finite weights; ownership/stretch failures remain                 |
| Amy, shoulder-plane correction   |     1.924 s |        694.6 MiB | Some leakage improves; not a safe full repair                     |
| Bulma                            |     2.393 s |        762.1 MiB | Clothing follows rigid limb regions; skirt is not collision-aware |
| Bulma, shoulder-plane correction |     2.401 s |        754.2 MiB | Does not solve knee/skirt contact                                 |

Times cover the solver, not loading/rendering. RSS includes the Node process, source asset, geometry
and solver data. Tests use a 2 GiB Node heap limit; this is not a physical low-memory-machine
qualification. All weight rows are finite/nonnegative and sum within 2.24e-8 of one.

Amy's worst sampled per-frame 99th-percentile edge stretch rises from **4.46×** rest with original
LBS to **12.00×** with this binder, or **11.03×** with shoulder-plane correction. Not every region
gets worse; the textured views show some improved trouser motion. The whole character still fails.
The authored control also deteriorates: walk P99 rises from 1.43× to 2.08×, jump-land from 1.60× to
2.42×. Finite weights and a fast runtime do not justify replacing an authored or existing skin.

**Verdict:** reject as an automatic default for these inputs. Its small CPU footprint remains useful
for a future guided comparison, after ownership is established. No character-specific plane or
threshold becomes a production rule.

## Dual-quaternion skinning

Across all 68 sampled poses, the largest per-frame 99th-percentile edge ratios are:

| Character | Original LBS | Mesh2Motion LBS | Shoulder-plane LBS | TokenRig LBS | Original DQS |
| --------- | -----------: | --------------: | -----------------: | -----------: | -----------: |
| Amy       |        4.46× |          12.00× |             11.03× |        6.62× |        4.81× |
| Bulma     |        2.43× |           6.34× |              6.43× |        2.34× |        2.92× |

The lower TokenRig percentile on Bulma does not remove visible skirt contact. The maximum is taken
over the complete frame rows; the private report's `worst` examples instead select the largest count
of edges above 2×, which can be a different frame. Do not confuse those aggregations.

A private NumPy implementation compares the same four weights and rigid skin matrices under LBS and
dual-quaternion skinning (DQS). It checks transform rigidity and quaternion hemisphere alignment. A
synthetic 160° cylinder twist establishes the expected distinction: LBS retains 17.36% of the radius
at the blended ring, DQS retains 100%; both agree for a single rigid transform.

On the real inputs this does not repair semantic ownership or garment contact. Amy's original-weight
worst P99 changes from 4.46× to 4.81×; TokenRig weights change from 6.62× to 6.94×. Authored-control
walk P99 changes from 1.43× to 1.47×. These are edge-strain measurements, not a volume score: the
cylinder establishes the volume benefit, while the characters demonstrate that it is not a general
quality fix. Exact-position duplicates remain coincident for every sampled candidate under both
methods; the existing seam fix is not the source of these failures.

**Verdict:** a useful optional future deformation mode for twisting joints, with shared core/viewer
support and explicit export semantics. Do not add it now as a solution to wrong weights or skirts.
No current preview/bake uses this private implementation. Corrective shapes/smoothing remain
distinct candidates and have not received a full new qualification in this pass.

## Independent motion and player checks

The independent FK control compares source and current core-retargeted knee motion on six targets
over four clips, 65 poses per clip. Maximum source/target knee-angle differences are 5.82–6.25° for
Amy and 3.31–3.42° for Bulma; the clean controls measure 3.69–4.30°. Bone lengths and bind-pose
differences account for a nonzero baseline; these numbers do not prove perfect motion.

Core's contact statistic ranges up to 4.76 mm on Amy and 3.71 mm on Bulma. The tall control reaches
8.39 mm on jump-start. This reports the retargeter's contact-height statistic, not a full foot-slip
or sole-collision qualification. Its existing 14 retarget regression tests pass.

An earlier independent Blender playback comparison reproduces three sampled walk surfaces within
0.00093 mm for Amy and 0.00264 mm for Bulma, using bidirectional nearest-point comparison after axis
conversion. This checks geometry evaluation, not index identity, shading, continuous motion or the
upstream retargeter's correctness. It does not test another animation pack.

**Verdict:** no evidence here supports replacing the animation library or player first. Keep contact
and rest-pose controls open, but prioritize skin ownership and garment contact.

## Blender automatic weights

The existing isolated `bpy` 4.2 process imported each original canonical mesh with vertex merging
disabled, kept its existing armature and ran Blender's bone-heat automatic weights. No new Blender
application or Python package was installed.

| Input            | Import and weighting | Unweighted vertices |
| ---------------- | -------------------: | ------------------: |
| Authored control |              0.885 s |           0 / 8,844 |
| Amy              |              18.53 s |   595,107 / 595,107 |
| Bulma            |              29.87 s |   628,916 / 628,916 |

Blender reports that bone heat cannot find a solution for the generated inputs. The control has
finite but not exactly normalized sums, so it too needs downstream validation. Output reports were
validated independently; the process subsequently exited nonzero. This is research evidence from an
old retained runtime, not qualification of maintained Blender LTS, Rigify or automatic remeshing.

**Verdict:** opening Blender and invoking automatic weights is insufficient. Rigify supplies a
different control-rig workflow, not automatic source-part separation or cloth collision. Detailed
guided editing remains plausible; automatic clean-up has not been proven on these meshes.

## MIA provisioning screen

The v1 dependency indices actually list CPython 3.11 Windows x64 and Linux x64 wheels for its pinned
PyTorch3D 0.7.7 / Torch 2.1.2 CUDA 12.1 and compatible torch-cluster lane. They do not list macOS
artifacts for this exact CUDA recipe. Wheel availability is not an executed installation or a safe
ABI upgrade to the existing environment.
[Upstream requirements](https://github.com/jasongzy/Make-It-Animatable/blob/main/requirements.txt),
[declared PyTorch3D index](https://miropsota.github.io/torch_packages_builder/pytorch3d/),
[PyG index](https://data.pyg.org/whl/torch-2.1.2%2Bcu121.html)

The upstream module constructs its kinematic tree by reading `data/Mixamo/bones.fbx` at import. An
anonymous request for that required dataset file returned **401 / GatedRepo**. No credentials,
template bypass, dataset acceptance, environment or checkpoints were installed. Exact template
access/rights and an independently qualified full-rig/retarget comparison remain prerequisites; v2
adds its separate backbone terms. This is **blocked before inference**, not a failed quality result.
[Template-loading source](https://github.com/jasongzy/Make-It-Animatable/blob/main/util/dataset_mixamo.py),
[dataset](https://huggingface.co/datasets/jasongzy/Mixamo)

## Platform and footprint conclusion

This pass ran Windows x64 CPU work and the separately recorded NVIDIA experiment. Mac Intel/ARM,
Linux, Windows ARM64, AMD/Intel GPUs and physically smaller NVIDIA cards remain unqualified. CPU
code and a model's OS label alone cannot establish support for native packages or acceleration.

A small registry correction now reports macOS CPU until a backend proves acceleration, handles
explicit `win32` correctly, refuses unknown OS recipes and bounds driver probes. The registry suite
passes 54 tests. Exact runtime architecture and model-job admission remain authoritative; first-GPU
install advice is still not multi-device selection or live free-memory admission.

No new ML/Blender dependency enters the base installer. Reuse the existing renderer, registry and
canonical assets. Keep large optional tools out until a repair beats the same ownership, detail,
motion and contact gates. Native CI/hardware runs and deployment/cancellation/removal qualification
belong to a candidate that passes, not to a rejected prototype.

Automatic approval review rejected the combined recursive checkpoint/environment cleanup with only
"blocked by policy." A narrower nonrecursive cleanup subsequently removed the two explicitly named,
hash-verified checkpoint copies: 1,618,915,724 logical bytes. The separate 82,739,474-byte research
overlay remains, along with proof meshes/images, logs, recipes and hashes. Existing installed model
environments and package caches were untouched. Replay must fetch the pinned checkpoints again; none
of this experiment storage increases the default app payload.
