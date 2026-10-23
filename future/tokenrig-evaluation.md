# TokenRig fixed-skeleton evaluation

Investigation on 2026-10-23. **Keep TokenRig experimental; do not replace the default rigger or add
it to the installer yet.** Its official skin-only path runs on this Windows/RTX 3090 setup and is
small enough to evaluate without another Blender installation. It does not solve these characters'
remaining ownership and clothing problems. This report records an isolated experiment, not a
production integration or a completed cross-platform qualification.

No live character, installed model environment, registry default or application behavior changed.
The experiment's recipes, hashes, candidate meshes and comparisons remain under the ignored
`.render-bench/quality-research-2026-10-23/tokenrig/` directory. After evaluation, a narrow cleanup
removed the two hash-verified checkpoint copies (1,618,915,724 logical bytes). The 82.74 MB overlay
remains because recursive environment cleanup was blocked by automatic review. Replaying inference
requires fetching the pinned checkpoints again; existing installed models and shared packages were
untouched. The footprint table below records measured evaluation-time sizes.

## What was held constant

The comparison uses Amy's 595,107 vertices / 28 joints and Bulma's 628,916 vertices / 52 joints.
Their original geometry, indices, textures, hierarchy, rest transforms and inverse binds are held
fixed. Only four skin indices and weights per vertex change.

The official existing-skeleton interface tokenizes and reconstructs joint coordinates. We therefore
did **not** accept the ordinary exported reconstructed rig. The private wrapper proves the retained
joint names and parent order match exactly, extracts the predicted weight columns with an explicit
identity mapping, and applies those columns to the original joints. No nearest-joint mapping is
used. Tokenization moves the conditioning coordinates by up to 0.01105 / 0.01353 in normalized space
for Amy / Bulma; those moved coordinates are never written into our rig.

All 68 frozen core poses per character cover 17 samples each of `walk-loop`, `jump-start`,
`jump-loop` and `jump-land`. The independently prepared renderer pose files reproduce the frozen
skin matrices **bit for bit**. The same core WebGPU renderer produces the original/candidate images,
with the same camera, light, full-resolution textures and four-influence linear blend skinning. The
writer also asserts geometry, texture, rig and existing animation accessor bytes survive the
candidate GLB round trip unchanged. These checks establish a controlled comparison; they do not
establish that the motion or weights are artistically correct.

The official default surface sampler uses 54,000 points. Predicted weights transfer back to the
original vertices through the upstream eight-neighbor inverse-distance interpolation, then are
normalized and limited to the four influences the current renderer supports. Voxel postprocessing is
off. The test does not include new skeleton prediction, semantic part labels, garment separation,
cloth simulation, corrective shapes, or a different animation pack.

[Official skin-only interface and defaults](https://github.com/VAST-AI-Research/SkinTokens/blob/273b691d35989d71cd17ff2895fdc735097b92d1/README.md),
[tokenizer](https://github.com/VAST-AI-Research/SkinTokens/blob/273b691d35989d71cd17ff2895fdc735097b92d1/src/tokenizer/tokenizer_part.py),
[generation implementation](https://github.com/VAST-AI-Research/SkinTokens/blob/273b691d35989d71cd17ff2895fdc735097b92d1/src/model/tokenrig.py).

## Quality result

**Amy fails visual acceptance.** The original weights drag the trousers outward with the hands.
TokenRig reduces that particular effect, but introduces conspicuous skin-colored triangles from the
hands back toward the hips. The front jump-start/jump-loop views and side walk frame 8 make this
especially clear. The new weights move the contact-region error; they do not resolve it.

**Bulma still fails the clothing requirement.** The skirt silhouette changes, but the knees remain
exposed through the skirt under the raised-leg/crouched poses. A learned skin-weight predictor has
no collision constraint between the moving leg and the garment. This experiment supplies no basis to
label a new rigger as a skirt-clipping fix.

The full frame sets were rendered; the reviewed contact sheets show samples 0, 4, 8, 12 and 16 in
both front and side views across every clip. These are representative visual checks rather than a
continuous swept-contact proof. The shared CPU harness evaluates all 68 sampled poses numerically.

The shared harness measures original mesh edges with rest lengths above 0.01 mm and below 5% of
character height. Each value below is its own maximum over all 68 sampled poses under the existing
linear blend skinning; the extrema can occur at different samples.

| Character / weights | Maximum per-pose P99 edge-length ratio | Maximum individual edge ratio | Maximum edges above 2× |
| ------------------- | -------------------------------------- | ----------------------------- | ---------------------- |
| Amy / original      | 4.464×                                 | 29.76×                        | 69,197                 |
| Amy / TokenRig      | 6.618×                                 | 109.02×                       | 45,467                 |
| Bulma / original    | 2.428×                                 | 8.28×                         | 26,763                 |
| Bulma / TokenRig    | 2.336×                                 | 26.53×                        | 22,780                 |

TokenRig reduces the number of highly stretched edges while making some local damage worse; Bulma's
slightly lower P99 does not remove the visible skirt/leg contact failure. A single aggregate score
cannot decide visual acceptance. Exact coincident-position seam disagreement remains zero in every
sampled pose: this is not a return of the previously repaired UV seam split. Edge strain diagnoses
deformation, not semantic correctness or collision.

Private artifacts:

- `tokenrig/visual/{amy,bulma}-walk-loop-comparison.png` compares original, TokenRig and the two
  independent Mesh2Motion CPU candidates with the same motion and renderer.
- `tokenrig/visual/{amy,bulma}-{jump-start,jump-loop,jump-land}-comparison.png` compares original
  and TokenRig during jumping.
- `tokenrig/visual/{amy,bulma}/{original,tokenrig}/{clip}/frames/` retains all 640×640 front/side
  core AOVs; `tokenrig.glb` and `tokenrig-walk-loop.glb` retain inspectable candidates.
- `cpu/{amy,bulma}-deformation.json` contains the shared full-sequence numeric results. DQS figures
  there belong to a separate CPU diagnostic; the rendered TokenRig images use the production LBS
  path.

These paths are relative to `.render-bench/quality-research-2026-10-23/` and are deliberately
ignored. Do not substitute research candidates into a user's project.

## Measured Windows cost

Windows x64, RTX 3090 24 GB, Python 3.11.16, PyTorch 2.7.0+cu128. Inference uses real FlashAttention
2.8.3. Measurements are observed on this shared workstation, not a hardware minimum or a
clean-machine installer certification.

| Measurement                                                          | Result and scope                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Official checkpoint download                                         | 1,618,915,724 bytes; 19.6 s; exact published SHA-256 verified     |
| Cold model load                                                      | 26.47 s inside the imported worker                                |
| Amy skin-only inference                                              | 9.56 s first / 9.14 s repeat                                      |
| Bulma skin-only inference                                            | 16.98 s first / 18.00 s repeat                                    |
| Worker including imports, preparation, load, four runs and transfers | 112.25 s                                                          |
| Peak worker process-tree working set                                 | 5,569,036,288 bytes = 5.19 GiB                                    |
| PyTorch peak GPU allocation / reservation                            | 3,691,066,368 / 4,129,292,288 bytes = 3.44 / 3.85 GiB             |
| NVIDIA global GPU memory baseline / peak                             | 1,943 / 6,236 MiB, including other desktop processes              |
| Private overlay environment logical file bytes                       | 82,739,474 bytes; shared packages excluded                        |
| Source checkout excluding checkpoints                                | 28,314,045 logical bytes, including Git/source assets             |
| Retained research visual outputs                                     | 642,486,139 logical bytes; evaluation output, not runtime payload |

The resource monitor follows the Windows virtualenv launcher's child processes; measuring only the
small redirector would incorrectly report about 7 MB. NVIDIA's global WDDM memory number is not a
private-process allocation measurement. Neither number replaces the separately recorded PyTorch
allocation/reservation counters.

**A standalone runtime footprint has not been measured.** This disposable environment uses a
read-only `.pth` reference to existing cached UniRig packages, avoiding duplicate PyTorch/CUDA
installation. The whole referenced site-packages tree is 8,411,426,984 logical bytes and contains
unused packages, including `bpy`; it is neither the experiment's new disk cost nor TokenRig's
minimum dependency set. No Blender executable or `bpy` import is needed for the neutral weight
inference and our existing glTF writer. Fresh compatible overlay wheel metadata totals about 19.85
MB compressed; hardlink allocation, cache sharing and actual per-wheel network transfer were not
measured.

The upstream advertised NVIDIA floor remains 14 GB. Our smaller skin-only observation is not
evidence to lower that catalog gate for the complete pipeline.
[Official runtime requirements](https://github.com/VAST-AI-Research/SkinTokens/blob/273b691d35989d71cd17ff2895fdc735097b92d1/README.md).

## Repeatability and platform gates

The untouched VAE feature sampler calls `numpy.random.default_rng(None)`. Setting Python, NumPy and
PyTorch's global seeds therefore did **not** make two raw official runs identical. An isolated
wrapper supplying seed 0 to that one feature sampler made both characters' repeat weights
byte-identical without changing weights or network architecture. The retained results distinguish
the raw repeat from this seeded adaptation. A product integration would have to record this seed and
include the adapter revision in provenance/cache inputs.

All predicted and transferred rows are finite and nonempty. Full rows are normalized explicitly; the
raw decoder does not produce a row sum of one. Mean / P99 discarded mass when reducing to four
influences is 0.228% / 5.883% for Amy and 0.0635% / 1.080% for Bulma. Numeric validity is not visual
acceptance.
[Feature sampler](https://github.com/VAST-AI-Research/SkinTokens/blob/273b691d35989d71cd17ff2895fdc735097b92d1/src/model/skin_vae/autoencoders/skin_fsq_cvae_model.py).

| Platform/lane                           | Evidence                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64 / NVIDIA                    | Actual full-resolution skin-only inference and core visual comparison completed using existing prebuilt dependencies. Fresh provisioning remains unqualified.                                                                                                                                                                                                                         |
| Windows x64 / CPU                       | Actual small 2,048-point CPU/SDPA probe attempted. Unadapted upstream import fails after 37.56 s on an unconditional CUDA device-name query. A private safe-query adaptation loads in 35.80 s after imports and reaches inference, but produces no weights before the 240 s process cutoff. Peak process-tree working set 3,871,473,664 bytes (3.61 GiB). This lane is not qualified. |
| macOS ARM64 / Metal                     | No native run here. Independent Rust/Candle port documents CPU/Metal inference, but has no published release binaries at the checked revision; a build, provenance/parity check and native test remain necessary.                                                                                                                                                                     |
| Linux x64 / NVIDIA                      | Upstream installation lane is plausible; no native SpriteBook run here.                                                                                                                                                                                                                                                                                                               |
| CPU/Vulkan C++ port                     | Independent implementation documents CPU/Vulkan, but the checked repository has no published prebuilt release. Building/qualifying it is a separate experiment, not a platform pass.                                                                                                                                                                                                  |
| Windows ARM64 / Linux ARM64 / Intel Mac | No qualified TokenRig artifact or run established by this test.                                                                                                                                                                                                                                                                                                                       |

The official Python constructor selects FlashAttention for its language model and has CUDA-specific
import probes/decorators. CPU/Metal support requires explicit adaptations and numeric/visual
qualification; a platform label cannot be inferred from PyTorch import success. The CPU probe used
the same checkpoint with GPU visibility disabled and PyTorch SDPA rather than external flash
attention, on eight OpenMP threads while other CPU research ran. It tests feasibility only: 2,048
points is below the evaluated 54,000-point production-like sampling, and the cutoff is not a
measured completion time or proof that CPU execution can never finish. No compiler or new toolchain
was installed to pursue the independent ports.
[CPU/Vulkan port](https://github.com/localai-org/skin-tokens.cpp),
[Rust CPU/Metal port](https://github.com/chris-straka/skintokens),
[port's measured scope](https://github.com/chris-straka/skintokens/blob/main/docs/evaluation.md).

## Provenance and deployment boundary

- Source: official `VAST-AI-Research/SkinTokens` commit `273b691d35989d71cd17ff2895fdc735097b92d1`,
  root MIT license.
- Checkpoints: official model revision `79736cad0fd84de384d5eede659b4ebd24effe33`, MIT model-card
  declaration. `grpo_1400.ckpt` SHA-256
  `f4e4706a11cfb520cdde65156a0358545e4fbf8f36237aca01ea5e79d5cb5692`; `last.ckpt` SHA-256
  `4843f49e58afff88345806b94ca82e6cc9d8def6e7432e2853c677b154de0ed4`.
- Qwen architecture config only: `Qwen/Qwen3-0.6B` revision
  `c1899de289a04d12100db370d81485cdf75e47ca`, Apache-2.0. No separate Qwen model weights fetched.
- The acknowledged Michelangelo encoder has GPL-3.0 provenance. The independent Rust port explicitly
  labels its derived encoder GPL and its linked executable GPL. This is an unresolved bundling gate
  under SpriteBook's permissive-dependency rule; the outer MIT label is insufficient. All evaluation
  remains in a separate private process. No encoder source is copied into app code.
- New overlays are pinned `transformers==4.57.1`, `diffusers==0.35.1`, `huggingface-hub==0.35.3`,
  `tokenizers==0.22.1`, `omegaconf==2.4.0`, `psutil==7.1.0`. The first four declare Apache terms and
  the latter two BSD terms in retained package metadata. OmegaConf 2.4 avoids a source-build-only
  antlr dependency encountered with 2.3. A complete redistributable transitive/CUDA wheel audit is
  still required before product provisioning.

`licenses/`, `package-provenance.json`, `overlay-wheel-metadata.json`, `footprint.json`,
`upstream-metadata.json`, `download-report.json` and the mapping reports retain these facts locally.
The verified official Torch checkpoints are loaded by upstream Python checkpoint code; model hashes
and source pins are required before that trusted research load. Training-asset attribution in a
model card does not grant redistribution rights to those source training assets.

[Pinned source license](https://github.com/VAST-AI-Research/SkinTokens/blob/273b691d35989d71cd17ff2895fdc735097b92d1/LICENSE),
[official model card](https://huggingface.co/VAST-AI/SkinTokens/blob/79736cad0fd84de384d5eede659b4ebd24effe33/README.md),
[original Michelangelo license](https://github.com/NeuralCarver/Michelangelo/blob/main/LICENSE),
[independent port provenance](https://github.com/chris-straka/skintokens/blob/main/PROVENANCE.md),
[Qwen config revision](https://huggingface.co/Qwen/Qwen3-0.6B/tree/c1899de289a04d12100db370d81485cdf75e47ca).

## Decision proposed

Reject a blanket TokenRig replacement on this evidence. Preserve it as an optional candidate for a
later, ownership-aware comparison after the source hand/trouser contact can be represented
explicitly. The current result is useful negative evidence: even finite, deterministic, plausible
weights from a newer model do not meet a normal user's acceptance bar.

Keep the default application footprint unchanged. A future optional tool would need permissive/GPL
boundary resolution, clean-machine prebuilt provisioning, reproducible generation, and native
platform validation. Garment/contact repair and source-part separation remain independent work. No
automated repair should replace a user's accepted rig without a reviewed comparison and undo.
