# F4 existing-model provisioning gate

**F4-T4 is complete as of 2026-10-19.** The installed Windows model workflow and recovery checks
pass. The [qualification receipt](qualification/model-workflow-windows-x64.json) records exact
artifacts and results. No model default, app-bundling rule or platform scope was waived.

## Pixal3D extension — F4-T6/T7

The approved extension is complete on the same Windows x64 / RTX 3090 host. The
[Pixal3D qualification receipt](qualification/pixal3d-windows-x64.json) pins functional commit
`767a698`, its private NSIS installer, all **6,157 runtime file seals**, complete model/source
receipts and raw proof hashes. The [hardware/platform spike](model-platform-spike.md) records the
model comparison, inspected images and exact Mac/Linux candidates.

Pixal3D is an optional catalog-managed single-view PBR generator, with real NAF, local-only DINOv3,
manual camera FOV and a separate frozen runtime. Native admission, empty-PATH Unicode installation,
generation/pick, UniRig, core preview, 144-frame styled/AOV bake, all four exporters and actual
Tauri model-manager/read projections pass. The two-candidate job takes **295.12 s**, with **17.53
GiB Torch reserved / 14.22 GiB allocated** and a sampled worker peak of **24.15 GiB working set /
46.87 GiB private commit**. Keep 24 GiB card admission and the 64 GiB qualification host.

The controlled repeat exposed non-repeatable GPU mesh reduction. Adapter 0.2.0 preserves native
remesh/UV/PBR processing, using canonical mesh ordering plus pinned CPU reduction/normal sums. Both
candidates' raw and canonical GLBs repeat byte-for-byte after an actual killed-worker retry.
Prepared-source corruption refuses execution; setup repairs it while preserving weights and accepted
assets. Offline inference records zero outbound attempts. Warm baking reuses 100% of frames and
preserves all five AOV pages after rig acceptance. Existing F4 accepted assets/bakes also retain
their original hashes.

The 52-joint rig and all sprite directions/clips were reviewed and explicitly accepted for this
bounded functional proof. Eight deformation advisories and unmapped `root`/`thigh_r` remain F3-T1
quality work; 0.545% idle flicker is measured on this fixture. TRELLIS.2 remains the default. The
latest affected suites pass **68/69 Node cases** with one existing weight-gated skip, plus **534
Python checks**, types/lint and native admission. The earlier 903-case migration suite remains its
own evidence and was not rerun wholesale. Native other-platform, clean-machine, signing,
distribution-notice, engine-import and soak gates remain F7 work.

## Current evidence

- [x] Complete TRELLIS.2 `af44b45f.local1` catalog version: all original weights, local sparse
      decoder, exact DINOv3 config/weights/agreement and explicit acceptance.
- [x] Local-only pipeline loading for generation and retexture. Missing or unknown dependencies fail
      before loading; no broad-exception Hub fallback or BRIA model.
- [x] Restricted rasterizers and the untraced O-Voxel wheel removed from the selected lock.
- [x] Source/archive hashes, bounded source preparation, frozen wheels and retained notices for the
      [Windows TRELLIS.2 recipe](../sidecar/runtimes/trellis2-win.json).
- [x] Native DRTK coverage, orientation, winding, chunk-offset and degenerate-UV checks; finite
      O-Voxel conversion and both real pipeline imports on RTX 3090. Cold native compilation also
      verifies all six sparse PBR sampling channels in a Unicode path.
- [x] CLI `models setup trellis2-4b --accept-license`: source verification, frozen wheel sync and
      native admission passed. Failed setup preserves verified weights.
- [x] Separate frozen UniRig Windows environment, including real native admission. Complete
      `36842e2b.local1` uses the two unchanged MIT checkpoints and our packaged architecture data;
      the restricted historical OPT config is omitted.
- [x] Final private NSIS installation outside the checkout: fresh app/Python/uv/HF caches, empty
      PATH, both model recipes provisioned by the shipped CLI and offline sidecar health.
- [x] Real installed U²-Net prep, generation/pick, retexture, UniRig, core animation preview,
      144-frame styled/AOV bake and all four exporters. Inspected rendered output and finite
      geometry/PBR/normalized skin weights. Warm-cache hits are 100%.
- [x] Actual installed Tauri Node/GPU/sidecar health and real workspace/thumb/mesh/atlas
      projections.
- [x] Worker death returns retryable `backend-failed`; retry succeeds. Prepared-source corruption
      refuses execution and `models setup` repairs it from pinned archives. Accepted mesh/bake
      hashes and the weight receipt remain unchanged.

The earlier development generation/retexture established compatibility; the installed proof above
now exercises the actual packaged path. Raw evidence is retained under
`.render-bench/f4/installed-model-proof/`; the qualification receipt above pins its hashes.

## Provisioning contract

`models install <id[@version]>` installs hash-verified weights, then the version's optional runtime
recipe. `models setup <id[@version]>` retries or reuses backend setup without deleting/downloading
weights. Both enforce the catalog's terms and platform gates. A runtime recipe is catalog data, not
a model-name branch in the CLI.

Core/registry own selection and policy; the packaged Python helpers only extract verified archives,
apply three bounded source substitutions and check native kernels. Setup uses owned uv, Python
3.11.16 and prebuilt third-party wheels. It requires no Git, compiler, checkout, retired spike path
or inherited HF cache. Receipts bind prepared source to recipe, lock and preparation/check scripts.
Core rechecks source hashes before exposing absolute paths to the sidecar. Environments live in
writable application data, outside immutable app resources.

Triton's pinned Windows environment reader misdecodes ANSI bytes and TinyCC cannot resolve Unicode
include paths. The shared adapter uses Python's Unicode reader and Triton's existing short-path
helper for compiler arguments. No wheel bytes are modified. Setup and inference own a writable
app-data Triton cache; the real cold kernel check catches these failures before publishing
readiness.

TRELLIS.2 uses Torch 2.8+cu128 and the optional sidecar environment. UniRig uses a separate Torch
2.7+cu128 environment; preserve its standard-attention workaround, 17.4 GiB admission floor,
pinned-checkpoint trust and numeric output validation. Native Mac, Windows ARM64 and Linux runs
remain F7 scope.

## Exact component terms

| Component                         | Recorded terms and treatment                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Official TRELLIS.2 source/weights | MIT; original inference, sampling, mesh cleanup and PBR stages retained. The prepared source only substitutes the UV boundary and dual-grid import.                                                                                                                                                                                                                                                                      |
| DRTK wheel                        | MIT notice present. Source `facebookresearch/DRTK@c5a3e523435b4daa37572c0653d6686531c787b2`; build `cuda-wheels@1b9490ad12df07a30594fa57f593e9b02423c387`, successful job 66761030740. Exact wheel hash in uv.lock.                                                                                                                                                                                                      |
| Replacement O-Voxel               | Source `Trellis.2.drtk@200ba8cb5a4039db8acde3c09edc43a0031b4098`; build `cuda-wheels@7bc41ac7b0b6596777da7a83c7933477a46b00ca`, successful job 73822567578. MIT plus Eigen MPL-2.0; recipe retains omitted notices and corresponding source URL. External download only.                                                                                                                                                 |
| UV helper                         | Adapted MIT approach; [notice retained](../sidecar/notices/uv-rasterizer-MIT.txt). Generation export and retexture use the same analytically checked helper.                                                                                                                                                                                                                                                             |
| CuMesh/FlexGEMM/utils3d           | MIT; exact wheel/archive bytes pinned. The supported inference path does not invoke utils3d's optional NVIDIA rasterization helpers.                                                                                                                                                                                                                                                                                     |
| DINOv3 conditioner                | Exact `ea8dc2863c51be0a264bab82070e3e8836b02d51` snapshot and [August 19, 2025 agreement](https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m/blob/ea8dc2863c51be0a264bab82070e3e8836b02d51/LICENSE.md). Custom use/trade and redistribution terms, separately accepted. Agreement hash `25d122eb8f5b880fd23c736fb6ea8018ee45c12237e00b8a86d14c653904999e`. It omits the older website's attribution clause. |
| UniRig                            | MIT code/weights with external GPL/Michelangelo/bpy components and separate dependency notices; do not describe the entire environment as MIT or bundle it into the permissive-only app payload.                                                                                                                                                                                                                         |

The old nvdiffrast/nvdiffrec artifacts carried evaluation-only use restrictions. They are absent
from the selected environment; moving them outside the installer would not have cleared their terms.
A file hash establishes identity, not permission. See the [BOM](../docs/dependencies.md) and exact
runtime recipes for delivery boundaries.

UniRig's new version does not download the historical OPT config. Its owned architecture description
comes from MIT fairseq/UniRig declarations, checkpoint tensor shapes and Apache Transformers
defaults. All 25 active settings match; real installed checkpoint inference passes. Preserve the
[architecture provenance](../sidecar/notices/unirig-opt-architecture.md) and fairseq notice. Legacy
model versions and their receipts remain intact for explicit historical use.

## Installed Windows qualification

Private candidate source: `2fbfadf`. Windows x64, RTX 3090/24 GiB, driver 610.88, Node 24.22.0, uv
0.12.10 and managed Python 3.11.16. These are single observed CLI elapsed times, including model
verification and process/model loading; they are not a new benchmark or cross-machine promise.

| Step                     |  CLI elapsed | Result                                                                                                                     |
| ------------------------ | -----------: | -------------------------------------------------------------------------------------------------------------------------- |
| TRELLIS.2 setup recovery |        122 s | Preserved verified weights/receipt after deliberate uv-offline Python failure; frozen sources/wheels and native check pass |
| UniRig install/setup     |        162 s | Separate Torch 2.7 environment and native check pass                                                                       |
| U²-Net prep              |         47 s | Subject preserved; background removed                                                                                      |
| Generation               |        221 s | Requested 1234; material gate rejects 1234/1235 and records 1236; 2K PBR textures                                          |
| Retexture                |        110 s | Same surface/triangle count and frame; UV vertex splits are allowed; accepted mesh unchanged until pick                    |
| UniRig                   |        145 s | 46 joints, required retarget joints present; finite normalized weights, maximum row-sum error 4.85e-8                      |
| Cold / warm bake         | 21.7 / 6.7 s | 144 frames, five rect-identical AOV pages, 0 / 100% cache hits                                                             |
| Export                   |        0.6 s | Godot, Aseprite, TexturePacker and strips written                                                                          |

All 144 exported frames contain the subject; each clip/direction has six distinct frames. The bake
reports 0.594% flicker and no bake flags. The rig still reports stretch advisories for `ring_02_l`
and `neck_01`; retargeting holds unmapped `root`/`spine_01` at rest. Normal explicit rig review and
acceptance remain in force. These model-quality cases belong in F3-T1 qualification; no sampling,
VRAM or quality threshold was relaxed to pass F4.

The [review sheet](qualification/model-workflow-review.png) was inspected. Row pairs show idle, walk
and punch at frames 0/3; columns show directions 0–7. This is an actual export, not a golden update.
The private installer passes all 6,149 file seals, and the synthetic installed lane also passes
importer, Track A, native-asset failure and owner-death/retry checks.

The final Node checks cover 903 cases: 896 pass and seven optional lanes are explicitly skipped. An
older running source sidecar initially locked its executable and caused 23 setup failures; all 23
pass when rechecked in a separate environment (31 passes/one weight-gated skip in that focused run).
Python selftest passes 516 assertions; types/lint and native admission pass. Goldens and tolerances
are unchanged; no image-suite automatic retry was used.

Inference uses uv/HF/Transformers offline modes and a Python socket guard rejecting non-loopback
connections; zero outbound attempts were recorded. Verified model files were imported with `--from`
outside the checkout; sources, Python and wheels were downloaded into fresh directories. This is
fresh-profile qualification on this developer machine. Native Mac/Windows ARM64/Linux, clean-machine
prerequisites, installer upgrades, signing, engine imports, accessibility and soak remain F7 release
requirements.
