# F4 existing-model provisioning gate

F4 remains open at **F4-T4** until the installed Windows runtime completes the real model workflow
below. Node cutover, fixture generation and real U²-Net prep already pass. No model default,
app-bundling rule or platform scope is waived.

## Current evidence

- [x] Complete TRELLIS.2 `af44b45f.local1` catalog version: all original weights, local sparse
      decoder, exact DINOv3 config/weights/agreement and explicit acceptance.
- [x] Local-only pipeline loading for generation and retexture. Missing or unknown dependencies fail
      before loading; no broad-exception Hub fallback or BRIA model.
- [x] Restricted rasterizers and the untraced O-Voxel wheel removed from the selected lock.
- [x] Source/archive hashes, bounded source preparation, frozen wheels and retained notices for the
      [Windows TRELLIS.2 recipe](../sidecar/runtimes/trellis2-win.json).
- [x] Native DRTK coverage, orientation, winding, chunk-offset and degenerate-UV checks; finite
      O-Voxel conversion and both real pipeline imports on RTX 3090.
- [x] Real generation: 168 s including load/export, seeds 1234/1235 rejected and 1236 recorded as
      successful. Real retexture: 67 s, topology preserved, frame shift 0. Empty HF cache and
      blocked outbound connections; no outbound attempts.
- [x] CLI `models setup trellis2-4b --accept-license`: source verification, frozen wheel sync and
      native admission passed. Failed setup preserves verified weights.
- [~] Separate frozen UniRig Windows environment: wheels-only resolution/install and inference
  imports pass. Real rigging and exact auxiliary-term review continue.
- [ ] Final installed fresh-profile model workflow, output inspection and failure recovery.

The first real model runs use qualified development environments. They establish model
compatibility, **not** the final installed/fresh-profile claim. Local evidence is retained under
`.render-bench/f4/`; checked-in qualification evidence follows once the installed workflow passes.

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

## Exit proof still required

1. Build/install the final Tauri/Node candidate outside the checkout in a Unicode path. Use fresh
   app data, empty PATH and HF cache; provision both existing models with the shipped launcher and
   owned uv. Record recipes, locks, notices and receipts.
2. Block outbound model access after setup. Run generation/pick, retexture, UniRig, preview, bake
   and export through the installed core/CLI. Retain real rendered subject inspection plus finite
   geometry, texture/PBR, rig and manifest checks.
3. Exercise corrupt/missing setup, interrupted inference and retry without replacing accepted
   workspace assets or a previous good bake. Confirm errors name recovery.
4. Rerun affected Node/sidecar/package checks, record evidence and mark F4 complete only after these
   requirements pass. Signing, release upgrades and additional native platforms remain F7; they are
   not quietly counted as F4 success.
