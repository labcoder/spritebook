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

**Retarget harness post-mortem (2026-07-12, after maintainer review):** the first
evidence round showed near-static upper bodies, crumpled forearms, and backward
("ostrich") knees. All three were **bugs in our spike retarget, not UniRig**: the
original implementation rotated each bone about its *rest* head and wrote absolute
placements, detaching children from the parent chain — measured knee flexion was ~zero
at every frame while the source clip flexed 0.4–0.97. Fixed by transferring world
*orientations* only (heads ride the updated parent chain), name-based bone mapping via
`tools/rename-bones.py` (sides verified against the factory rig), and facing-yaw
conjugation (measured ~0° for these assets). Post-fix, the humanoid walks with correct
knee hinge (flexion 0.34–0.95, matching source), natural arm swing, and clean shoulder
deformation — and the earlier "forearm weight weakness" attributed to UniRig largely
evaporated. Remaining honest weakness: the Giant's arm/torso boundary still shreds
mid-cycle (sparse 22-bone prediction + human clip force-fit + rough arm weights).
Judge interactively on `out/*-rigged-named.glb` (semantic bone names — these are also
the files to upload to Mesh2Motion's retarget page, which needs names for Auto-Map).

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

1. The Giant's arm/torso boundary weights are rough — visible shredding under
   animation even after the harness fixes (sparse bones + chunky proportions).
   (Retracted from round 1: humanoid forearm crumple — that was our harness bug.)
2. Sparse predictions on chunky characters (22 bones) → large rigid regions; fine for
   sprites at 128 px, limits close-up fidelity.
3. Generic `bone_N` names break name-based tooling downstream (Mesh2Motion Auto-Map,
   retarget profiles) → the production adapter needs a semantic-naming pass; our
   position-based `tools/rename-bones.py` (side-verified, mirror-guarded) is the seed.
4. Model-output NaN is a real, silent failure class → adapter-level NaN/row-sum
   validation is mandatory (tier-1 repair candidate: auto-retry with different seed).
5. Merge-stage weight renormalization needs guarding when inputs contain
   zero-weight vertices.
6. Left/right assignment on near-symmetric characters is genuinely ambiguous from
   geometry alone (our mirror-detection tied to float noise until anchored to the
   factory rig) — retarget profiles should record side anchors explicitly.

## Maintainer inspection (the ≥2-of-3 call)

- Contact sheets (regenerated 2026-07-12 with the fixed retarget):
  `spikes/autorig/evidence/{humanoid,stylized,asymmetric}-walk-sheet.png`.
  How to read them: columns = 6 evenly spaced frames of the Walk clip; row 1 = full
  figure 3/4 view; rows 2–3 = fixed close-up crops framed on shoulders and pelvis (the
  roadmap's two trouble joints).
- Rigged characters with semantic bone names (pose by hand in Blender, or upload to
  Mesh2Motion): `spikes/autorig/out/{humanoid,stylized,asymmetric}-rigged-named.glb`
- Animated: `spikes/autorig/out/*-walk.glb` (single clip `RetargetBake_Armature`)
- Best interactive judge: Mesh2Motion retarget page with the **-named** glbs — steps
  and per-character mapping notes in `anim/MESH2MOTION-RETARGET.md`

## Clip-source note (Quaternius UAL vs Mesh2Motion)

No dependency decision changed: **D-013 still bundles Quaternius UAL free tiers as the
primary animation pack**; Mesh2Motion remains the BOM's explicitly-cleared alternate
(art CC0, code MIT) and is the harness the roadmap itself names for this spike. The
spike used M2M clips because they are directly downloadable from the repo without an
account (UAL's free tier had no signup-free URL — provenance in `anim/NOTES.md`), and
both packs target the same UE-style 66-joint humanoid convention, so the retarget
profile work transfers.

## Reproduce

```powershell
cd spikes/autorig
# env: see README.md (uv). Then per mesh:
.\tools\rig-one.ps1 -Name humanoid -InputGlb assets\humanoid-static.glb -Seed 42
.\.venv\Scripts\python.exe render\retarget-bpy.py --rigged out\humanoid-rigged.glb --clip anim\human-base-animations.glb --clip-name Walk --output out\humanoid-walk.glb --frames 16
.\.venv\Scripts\python.exe render\contact-sheet.py --input out\humanoid-walk.glb --output out\humanoid-walk-sheet.png --frames 6 --clip RetargetBake_Armature
```
