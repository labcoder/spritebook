# P0-T4 report — auto-rig taste test (UniRig)

**Status: pipeline proven end-to-end on native Windows; all three test characters rigged,
skinned, retargeted, and rendered. The ≥2-of-3 "no grotesque deformation" acceptance call
belongs to the maintainer** — evidence below and in `evidence/*.png`; interactive
inspection paths at the bottom. The lead's read: humanoid and asymmetric are genuine
passes at the hips/legs/torso with forearm artifacts partly attributable to our crude
spike retarget; the stylized Giant walks at the legs but shreds at the arms.

- Date: 2026-07-12 · Task: P0-T4 (`docs/internal/roadmap/p0.md`) · Seed 42 everywhere
- Machine: Windows 11, RTX 3090 24 GB, driver 610.47 · uv-managed Python 3.11.15 venv
- UniRig @ main (2026-06), checkpoints `VAST-AI/UniRig` (skeleton 1.44 GB + skin 4.38 GB, HF cache)

## The three characters (all CC0 inputs, `assets/`)

| character | input | predicted bones | visual verdict material |
|---|---|---|---|
| humanoid (UBC Superhero_Male, rig stripped) | 8,483 v / 14,318 t | **52** | legs stride with sane knees, hips/torso deform well; forearms crumple (see caveat) |
| stylized (Quaternius Giant, 3.9 m chunky) | 3,158 v / 3,812 t | **22** | legs/hips walk plausibly; arm/torso boundary shreds mid-cycle |
| asymmetric (humanoid, left forearm→stump) | 8,483 v / 14,318 t | **34** | **adapted to the missing limb** — no hallucinated mirror arm, stump deforms plausibly, gait intact (D-008 founding-constraint evidence) |

**Retarget caveat (important for the taste call):** animation evidence uses our own
quick position-mapped retarget (`render/retarget-bpy.py`, nearest-bind-position bone
mapping + world rotation-delta baking of the Mesh2Motion CC0 Walk clip). It ignores
bone-roll/twist axes, so **forearm crumpling is partly harness artifact, not purely
UniRig skinning**. Judge shoulders/hips/torso from the sheets; judge overall quality
interactively on `out/*-rigged.glb` (bind pose + pose bones by hand), and optionally
re-run through Mesh2Motion's proper retarget page (`anim/MESH2MOTION-RETARGET.md`).

## Sidecar-budget numbers (per mesh, RTX 3090, seed 42)

| stage | wall time | notes |
|---|---|---|
| extract (bpy decimate→npz) | 5.7–7.3 s | CPU |
| skeleton predict | 25–32 s (≈5–10 s inference + model load) | AR OPT-350M |
| extract #2 (skeleton fbx) | 3.4–4.1 s | CPU |
| skin predict | 27–34 s (≈3–6 s inference + model load) | PTv3 + cross-attn |
| merge (bpy, writes rigged glb) | 5.7–7.8 s | CPU |
| **end-to-end** | **≈75–85 s/mesh** | model loads dominate; batching amortizes |
| peak VRAM | **10.0 GiB** (flash path) / **17.4 GiB** (non-flash workaround, see below) | sampler CSVs in `work/` |
| disk | checkpoints 5.8 GB (HF cache) + env ~9 GB (torch cu128 stack) | |

## What it took to run on native Windows (all documented, uv-managed)

Environment: `README.md` recipe — torch 2.7.0+cu128, prebuilt flash-attn
2.8.3+cu128torch2.7 cp311 wheel, spconv-cu124, PyG +pt27cu128 wheels, bpy 4.2 pip
module, numpy re-pinned 1.26.4, **triton-windows 3.3.1** (flash-attn imports triton at
module load). Installed cleanly by uv in minutes; no source builds; WSL2 fallback never
needed.

Three upstream patches (gitignored clone; each marked `SPIKE PATCH` in-file):

1. **`configs/model/unirig_skin.yaml`: `enable_flash: False` for PTv3** — the real find
   of this spike. PTv3's serialized attention calls
   `flash_attn_varlen_qkvpacked_func` directly, and that kernel in the Windows wheel
   (2.8.3+cu128, sm_86) **commits an illegal memory access** → 100% NaN skin weights
   under bf16 (silent!) or a hard CUDA fault under fp32. Diagnosed via NaN-census of
   `predict_skin.npz` (32768×52 weights, all NaN), `CUDA_LAUNCH_BLOCKING=1` stack, and
   spconv/MHA exoneration probes. PTv3's standard-attention path fixes it at the cost of
   +7.4 GiB peak VRAM. *Sidecar lesson: adapters must validate model outputs (NaN
   checks) — the stage exits 0 while producing garbage.*
2. **`run.py`: `weights_only=False`** on `trainer.predict` — torch ≥2.6 safe-unpickler
   rejects the skin checkpoint's embedded `box.Box`. Registry pins checkpoint hashes
   (D-009), so trust is anchored there.
3. (workflow, not a patch) **bpy-in-process stages crash 0xC0000005 at interpreter
   teardown _after_ completing their work** — extract and merge routinely, PNG/glb
   already written. `tools/rig-one.ps1` validates expected artifacts instead of trusting
   exit codes for bpy stages. *Sidecar lesson: artifact-validation, not exit codes, for
   bpy steps; run them in disposable subprocesses.*

Also hit: UniRig merge divides by the (NaN) weight sums — the visible
`invalid value encountered in divide` warning was downstream echo of #1, not the cause;
Blender's glTF exporter parks unweighted vertices on a synthetic `neutral_bone` (how the
NaN problem first surfaced as "mesh doesn't follow bones").

## Objective joint-placement check (rough)

Nearest-neighbor distance from stripped-factory-rig joints to predicted joints
(unit-height normalized; `tools/score-joints.py`): humanoid median 0.17, stylized median
0.33. **Treat as appendix-grade** — the two joint sets live in different normalization
spaces and joint densities differ (52 pred vs 65 GT incl. fingers), so the visual
evidence is primary. A proper metric belongs to p3's rig QA design.

## Platform verdict (registry gate data, D-009)

UniRig is **CUDA-only**: skinning imports `flash_attn` + `spconv` unconditionally
(neither ships macOS/Metal builds); zero Apple Silicon reports upstream. Registry entry:
`platforms: [windows-cuda, linux-cuda]`, `min_vram: 8GB` (measured floor on Windows
today: ~10 GiB flash / ~17.4 GiB non-flash at 50k faces). macOS users will need a
different backend or remote execution — exactly what D-009's gates exist to express.
The **SkinTokens hedge** (successor model, MIT) was pre-approved but not invoked; it
remains the first thing to try if the maintainer scores this <2-of-3.

## Failure-mode catalog (seeds tier-1/tier-2 repair design)

1. Forearm/wrist weight quality degrades on stylized+thin geometry (even discounting the
   retarget twist artifact, the Giant's arm boundary weights are rough).
2. Sparse predictions on chunky characters (22 bones) → large rigid regions; fine for
   sprites at 128 px, limits close-up fidelity.
3. Finger bones predicted for the humanoid but not articulated by our clip mapping —
   harmless for sprite-scale work.
4. Model-output NaN is a real, silent failure class → adapter-level NaN/row-sum
   validation is mandatory (tier-1 repair candidate: auto-retry with different seed).
5. Merge-stage weight renormalization needs guarding when inputs contain
   zero-weight vertices.

## Maintainer inspection (the ≥2-of-3 call)

- Contact sheets: `spikes/autorig/evidence/{humanoid,stylized,asymmetric}-walk-sheet.png`
- Rigged characters (bind pose, pose them by hand in Blender):
  `spikes/autorig/out/{humanoid,stylized,asymmetric}-rigged.glb`
- Animated: `spikes/autorig/out/*-walk.glb` (single clip `RetargetBake_Armature`)
- Optional better retarget: upload a rigged glb at Mesh2Motion's retarget page — steps
  in `anim/MESH2MOTION-RETARGET.md`

## Reproduce

```powershell
cd spikes/autorig
# env: see README.md (uv). Then per mesh:
.\tools\rig-one.ps1 -Name humanoid -InputGlb assets\humanoid-static.glb -Seed 42
.\.venv\Scripts\python.exe render\retarget-bpy.py --rigged out\humanoid-rigged.glb --clip anim\human-base-animations.glb --clip-name Walk --output out\humanoid-walk.glb --frames 16
.\.venv\Scripts\python.exe render\contact-sheet.py --input out\humanoid-walk.glb --output out\humanoid-walk-sheet.png --frames 6 --clip RetargetBake_Armature
```
