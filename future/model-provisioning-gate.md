# F4 model provisioning gate

Investigated **2026-10-19**. The user confirmed that **F4 remains open** until the incumbent model
setup gate is resolved. The Node/Windows proofs do not establish fresh TRELLIS.2 or UniRig setup.
This note separates reproducibility fixes from permission and product-support claims; it does not
select another model or relax the dependency policy.

**Implementation progress:** `af44b45f.local1` now declares the exact DINOv3 config, weights and
agreement behind explicit acceptance, retaining the original weight-only version. The shared adapter
loader resolves decoder/conditioner files locally without rewriting verified configs or using Hub
fallback. Its missing-file/traversal/selection regressions pass. The remaining source, optional
environment and permitted rasterizer work below still needs native qualification.

## What the current installation provides

The [runtime builder](../tools/runtime/build.mjs) ships the base sidecar project, frozen lock,
wheel-fetch helper and wheel hashes. It does **not** ship the CUDA wheels, backend checkouts,
virtual environments or weights. [Core](../packages/core/sidecar.ts) starts a base, lock-specific
writable environment. Its command does not request the `trellis2` extra. Preparing the checkout's
`.venv` therefore does not prepare the installed application's different environment.

The [extra](../sidecar/pyproject.toml) locks Python 3.11, Torch 2.8.0+cu128, torchvision 0.23.0,
xformers 0.0.32.post2, transformers 5.14.1 and five Windows cp311 CUDA wheels. Other dependency
versions are resolved in [uv.lock](../sidecar/uv.lock). `utils3d` is a pinned Git dependency, so a
fresh setup also needs a way to obtain/build that Python package without silently requiring a global
Git installation. The extra is Windows-only; catalogued Linux CUDA platforms are not a qualified
Linux installation recipe. uv does not select extras by default; `uv run` is inexact, so it can
retain an already-prepared extra, but does not install a missing one automatically.
([uv synchronization contract](https://docs.astral.sh/uv/concepts/projects/sync/),
[pinned utils3d build metadata](https://github.com/EasternJournalist/utils3d/blob/9a4eb15e4021b67b12c460c7057d642626897ec8/pyproject.toml))

## Initial technical findings

This table records the initial audit; implementation progress is recorded above.

| Requirement                    | Current state                                                                                                                                                                                                                        | Smallest necessary correction                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TRELLIS.2 source               | `_ensure_importable` accepts any importable package or the path named by `SPRITEBOOK_TRELLIS2_CODE`; the README proposes a moving shallow clone. Neither the weight version nor wheel lock pins this source.                         | Pin and verify one compatible source archive/commit, preserve its notices, and use an absolute writable external source path. No compiler or checkout-local spike is an installation prerequisite.                                                                                  |
| Installed optional environment | Source `uv sync --extra trellis2` and installed base launch address different environments. Source overrides exist, but are not a complete setup procedure.                                                                          | Provide an explicit, frozen optional setup using the same `UV_PROJECT_ENVIRONMENT` and project that the installed launcher will use; verify wheels first. Reuse the existing `SPRITEBOOK_SIDECAR_DIR` override for a writable prepared project where necessary. Keep CUDA optional. |
| Sparse-structure decoder       | The catalog declares the decoder under `deps/trellis-image-large/ckpts/…`, but upstream `pipeline.json` names `microsoft/TRELLIS-image-large/ckpts/…`. The current adapter does not remap it.                                        | Resolve that exact logical dependency to the already-verified local files before loading; refuse a missing local file. Do not edit the hash-verified pipeline file or fall back to an unpinned Hub download.                                                                        |
| DINOv3 conditioner             | Both pipelines request `facebook/dinov3-vitl16-pretrain-lvd1689m`; its files, revision and separate terms are absent from the TRELLIS.2 catalog entry. The loader can use an unrelated cache or download the moving repository head. | Declare the gated dependency, exact config/weight hashes and terms. After personal access approval, download through authenticated installation and load its verified local directory with network fallback disabled.                                                               |
| UniRig source/environment      | The adapter invokes a separate Python interpreter and checkout. Defaults point into retired `spikes/autorig`; no current committed, frozen UniRig environment recipe replaces them.                                                  | Pin source plus a separate Windows wheel-only environment, then set `SPRITEBOOK_UNIRIG_HOME`/`SPRITEBOOK_UNIRIG_PYTHON` to those absolute paths. Preserve the adapter's standard-attention workaround and checkpoint/output validation.                                             |
| UniRig auxiliary config        | The catalog **already includes** `opt-350m/config.json` plus both checkpoints. The adapter prefers that local file and disables Hub/Transformers network access in stages.                                                           | Retain and exercise this F1 fix with an empty HF cache. Correct stale text saying the config is not shipped; do not add OPT model weights or tokenizers without an actual loader requirement.                                                                                       |

Local evidence:
[TRELLIS.2 source/runtime/load/export seams](../sidecar/spritebook_sidecar/adapters/trellis2.py),
[retexture loader](../sidecar/spritebook_sidecar/adapters/trellis2_retexture.py),
[UniRig prerequisite/config/stage handling](../sidecar/spritebook_sidecar/adapters/unirig.py),
[catalog files and terms](../packages/registry/catalog/models.json), and
[wheel download verification](../sidecar/fetch_wheels.py).

The decoder issue was a concrete receipt bypass. Official
[`Pipeline.from_pretrained`, lines 26–43](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/trellis2/pipelines/base.py#L26)
tries `<modelDir>/<reference>`, catches **any** loading exception, then retries the reference as a
Hub model. The
[pinned pipeline config](https://huggingface.co/microsoft/TRELLIS.2-4B/blob/af44b45f2e35a493886929c6d786e563ec68364d/pipeline.json)
contains the mismatched cross-repository name. The adapter now patches the existing
`_prepare_runtime`/loader preparation shared by generation and retexture to supply verified local
model references and a local-only DINO constructor before either `from_pretrained` call. It refuses
unknown or absent dependencies; offline flags are a second guard, not a substitute for path
resolution. The official
[DINO extractor](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/trellis2/modules/image_feature_extractor.py#L58)
currently calls Transformers with a model name and no revision/local-only restriction.

UniRig's
[official installation instructions](https://github.com/VAST-AI-Research/UniRig/blob/6793c6640ff01c8fb389f3993434124bb43d2933/README.md#L55)
use partly unversioned packages and platform-dependent spconv/PyG/flash-attention installation; they
are not a frozen Windows recipe. Recover the measured Torch 2.7+cu128, numpy 1.26.4,
flash-attention/PyG/spconv combination from the preserved P0 evidence, then pin and verify its
actual wheels. Do not merge it into the incompatible TRELLIS.2 environment or run upstream source
compilation on users' machines. Absolute checkpoints already bypass UniRig's
[Hub downloader](https://github.com/VAST-AI-Research/UniRig/blob/6793c6640ff01c8fb389f3993434124bb43d2933/src/inference/download.py).

## What the licenses establish

All five local extension wheels were read as ZIP archives and their complete bytes matched
[`wheels.lock.json`](../sidecar/wheels/wheels.lock.json), whose source is community repository
commit `438fe4e2a15bd29620a1cedad0a87c5afad6f81d`. A hash establishes identity, not permission or a
reproducible native build.

| Exact component                               | Verified evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Consequence                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nvdiffrast` 0.4.0, SHA prefix `7362a491d801` | Wheel contains NVIDIA Source Code License, §3.3. The current official [license at `253ac4fc`](https://github.com/NVlabs/nvdiffrast/blob/253ac4fcea7de5f396371124af597e6cc957bfae/LICENSE.txt) retains the research/evaluation-only use limitation.                                                                                                                                                                                                                                                                                 | This artifact has no verified general commercial-use permission. Moving it outside the app installer does not remove its use restriction.                                                                                                                                    |
| `nvdiffrec_render` 0.0.0, `2bc74423d15c`      | Wheel contains the same restriction in NVIDIA's nvdiffrec license, §3.3. The [current official text at `abf3a34b`](https://github.com/NVlabs/nvdiffrec/blob/abf3a34b1eb6e782abffefc2462c7e9bcd89f9bb/LICENSE.txt) still restricts use.                                                                                                                                                                                                                                                                                             | No verified upstream relicense closes the recorded gate. Establish which imports are needed rather than installing an unused restricted component automatically.                                                                                                             |
| `o_voxel` 0.0.1, `531e370e7768`               | Wheel has no license text/metadata. Official [Microsoft source license](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/LICENSE) is MIT and O-Voxel is in that tree. Ten of eleven wheel Python files match that source after newline normalization; `convert/flexible_dual_grid.py` differs, and `_C.cp311-win_amd64.pyd` has no recorded source/build mapping.                                                                                                                              | **Artifact provenance/notices remain unverified.** Missing wheel metadata alone does not establish that all upstream O-Voxel source is unlicensed. Resolve the Windows changes/native origin and retain the actual applicable notices, or obtain a traced replacement wheel. |
| `cumesh` 1.0 / `flex_gemm` 0.0.1              | Each pinned wheel contains an MIT license.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Preserve notices and target/ABI pins; this does not clear other wheels.                                                                                                                                                                                                      |
| DINOv3                                        | [Model API](https://huggingface.co/api/models/facebook/dinov3-vitl16-pretrain-lvd1689m) reports manual gating at `ea8dc2863c51be0a264bab82070e3e8836b02d51`. That snapshot's [verified agreement](https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m/blob/ea8dc2863c51be0a264bab82070e3e8836b02d51/LICENSE.md) grants use/distribution under custom terms, requiring the license copy on redistribution, research acknowledgment and compliance with trade/use restrictions; it omits the “Built with DINOv3” clause. | Personal approval/authentication and explicit custom-term acceptance belong to this separately declared, user-installed dependency. It is not an MIT bundled dependency.                                                                                                     |
| UniRig                                        | [Code](https://github.com/VAST-AI-Research/UniRig/blob/6793c6640ff01c8fb389f3993434124bb43d2933/LICENSE) and [pinned weight card](https://huggingface.co/VAST-AI/UniRig/blob/36842e2b5947e9e60f89275b83208c8e74071c63/README.md) declare MIT. The tree also has a separate [Michelangelo GPLv3 license](https://github.com/VAST-AI-Research/UniRig/blob/6793c6640ff01c8fb389f3993434124bb43d2933/src/model/michelangelo/LICENSE); bpy is likewise external GPL tooling.                                                            | Preserve the separate subprocess/environment boundary and per-component notices. The root MIT declaration is not a license inventory for the whole environment.                                                                                                              |

DINO's public sources differ:
[Meta's website](https://ai.meta.com/resources/models-and-libraries/dinov3-license/) (August
14, 2025) includes the “Built with DINOv3” clause; the
[official GitHub agreement at `ffb4bb89`](https://github.com/facebookresearch/dinov3/blob/ffb4bb89c6558ca3244655c25a3955d01788b732/LICENSE.md)
(August 19, 2025) and the exact HF snapshot agreement omit it. The latter was retrieved with the
existing authorized HF login and independently hashed: SHA-256
`25d122eb8f5b880fd23c736fb6ea8018ee45c12237e00b8a86d14c653904999e`; the retained local evidence is
`.render-bench/f4/dinov3-license/LICENSE.md`. Preserve that agreement and its acceptance; the
agreement also contains an amendments clause, so snapshot identity alone does not settle every
future-use question. Earlier attribution-only descriptions have been corrected; do not infer a
blanket ruling about commercial asset outputs.

The restricted rasterizer is on the **textured asset path**. The exact O-Voxel wheel's
`postprocess.to_glb` imports `nvdiffrast` and invokes its CUDA context, rasterize and interpolate
operations. Its Python file matches
[official source, lines 223–249](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/o-voxel/o_voxel/postprocess.py#L223).
[Retexturing also calls those operations](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/trellis2/pipelines/trellis2_texturing.py#L297).
Disabling visualization therefore does not clear our current gen/retexture workflow. Microsoft's
[license discussion](https://github.com/microsoft/TRELLIS.2/issues/22) includes a collaborator's
visualization-only statement, followed by the unresolved textured-export question; the actual calls
take precedence over that general statement.

## Concrete order of work and closure

1. Fix local decoder/conditioner resolution, declare DINO files/terms, pin the two backend source
   trees, and provide frozen optional setup that targets the installed environment and names its
   actual paths. The gated error now names `hf auth login`. These are implementable F4 changes; none
   needs a new general model manager.
2. Close O-Voxel's precise provenance/notice gap. Audit the selected environment's actual artifacts,
   not a repository badge. Existing optional downloads are not app-bundled components, but their own
   permissions still govern their use.
3. For evaluation under verified terms, run the fresh installed workflow with disclosed evaluation
   restrictions. This can supply technical evidence; it **does not** establish the existing product
   promise of commercial game assets. For that promise, the NVIDIA-dependent texture operations need
   a qualified permitted replacement, or permission from their rights holder covering the exact
   use/artifacts. No such replacement or permission was verified here. Replacing the narrow
   rasterization boundary while retaining TRELLIS.2 is an investigation option, not a completed fix
   or a proposal to change the model default.
4. Run real installed TRELLIS.2 generation/retexture and UniRig through canonical import, core
   preview, animation, bake and all exporters. Use empty/unrelated HF caches, relocated model roots,
   Unicode paths and no checkout/spike fallback; after declared setup, deny outbound downloads.
   Exercise cancellation/death/retry and validate texture/rig numbers plus rendered pixels.

The [bundling allowlist](../docs/dependencies.md) applies to shipped application resources; it does
not silently prohibit every custom-term user-installed model. Conversely, neither a subprocess nor
user installation converts evaluation-only permission into commercial permission. Keep F4 open with
the remaining technical and terms gates named until its real-workflow acceptance is met. F7 still
owns artifact distribution clearance, signing and the deferred native platform qualification.

This was a source/artifact inspection, not an inference run. Only the gated license file was fetched
using existing authorized authentication; no token was printed. No heavy models, environment
installs, license exception or new backend were used.
