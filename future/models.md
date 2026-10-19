# Models and local generation

Research snapshot: **2026-10-18**. These are remake proposals; no current catalog entry or
hardware-support claim is changed.

**Implementation scope:** retain Tauri and the TypeScript core while replacing Deno, as confirmed by
the maintainer. Python/C++ model runners remain external components, not a proposal to port product
behavior. [Approved repository strategy](migration-strategy.md). New model integrations follow the
required runtime migration; retaining existing supported generation/rigging behavior is a release
gate.

**Recommendation:** benchmark **Pixal3D against TRELLIS.2**, using their newer implementations
alongside the existing adapter. Give **trellis.cpp** the first portability spike and **native
ComfyUI** the first Python runner spike. Preserve mesh import as a complete product path. Hunyuan3D
should not be the worldwide default under its examined terms. App support, generation support, and
auto-rigging support need separate promises.

The main change since the [August backend audit](../docs/internal/proofs/backends.md) is the
implementation landscape. Comfy Org announced native TRELLIS.2/Pixal3D in ComfyUI 0.34.0 on August
31, replacing the reference pipeline's non-commercial rasterization dependencies. The old rejection
of Pixal3D's reference environment is no longer a rejection of every implementation. This
establishes an alternative to investigate, not SpriteBook validation or complete license clearance.
[Comfy announcement](https://blog.comfy.org/p/trellis2-and-pixal3d-are-now-native)

## Evidence and confidence

| Label                | Meaning                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Upstream fact**    | A primary repository, legal file, release, model card, or API documents it. Performance can still be an unverified upstream claim.       |
| **Repo measurement** | A checked-in SpriteBook proof records a run. Its configuration and hardware matter. No new generation benchmark was run for this review. |
| **Proposal**         | A recommendation to decide and validate.                                                                                                 |
| **Unknown**          | Adequate evidence or a SpriteBook test is missing. Do not turn this into a support badge or measured memory floor.                       |

Confidence is high in examined release contents and legal-text differences; medium in the best
long-term runner; unknown in comparative sprite quality until a benchmark exists. Code, weights,
conditioning models, post-processing, compiled dependencies, runner, and output terms are separate
license questions.

## Text, images, meshes, and animation

TRELLIS.2 and Pixal3D are **image-to-3D** systems. Local Hunyuan3D 2.x shape generation is
image-conditioned; painting is an additional component. These paths emit geometry/materials, not a
finished SpriteBook skeleton, skin weights, clip bindings, or validated animations. A textured GLB
feeds rigging. [TRELLIS.2](https://github.com/microsoft/TRELLIS.2),
[Pixal3D](https://github.com/TencentARC/Pixal3D),
[Hunyuan3D 2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1)

**Proposed prompt workflow:** `text → reference image → approve reference → image-to-3D → canonical
mesh → rig → animate → sprites`. Preserve the prompt, image-model revision/seed, image hash, edits,
and 3D receipt. The explicit reference checkpoint lets users correct a tattoo, prosthetic side,
outfit, or pose before 3D inference. Label this as a composed workflow, rather than native text
conditioning in Pixal3D.

**Z-Image-Turbo** is a credible optional reference-image experiment: its official card describes a
6B image model and its source has Apache-2.0 legal text. Encoder, VAE, converted weights, and runner
still require artifact audits. No SpriteBook resource floor or Mac qualification exists here. Users
can bring images from another tool without installing this stage.
[Official card](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo),
[source license](https://github.com/Tongyi-MAI/Z-Image/blob/main/LICENSE)

Original **TRELLIS-text** has actual direct text-conditioned `base`, `large`, and `xlarge` models,
distinct from TRELLIS.2. Microsoft itself recommends image generation followed by image-conditioned
models for better detail. Keep direct text as an experimental comparison, with a separate audit of
the original decoder/rasterization stack. [Original TRELLIS](https://github.com/microsoft/TRELLIS),
[text-large weights](https://huggingface.co/microsoft/TRELLIS-text-large)

## Model shortlist

Recommendations describe future eligibility, not features already implemented.

| Candidate                                    | Inputs and output                                                                                                 | Product fit and recommendation                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pixal3D, current TRELLIS.2-based release** | Single image; current upstream also has camera-conditioned multiview inference. Mesh and PBR attributes/textures. | **Leading default candidate** after benchmarking. Pixel correspondence makes identity retention promising; a faithful front does not prove a correct back or deformable topology. |
| **TRELLIS.2-4B**                             | Image → geometry/PBR; separate shape-conditioned texturing.                                                       | **Baseline and optional alternative** through an audited engine. Existing receipts and failure evidence remain useful.                                                            |
| **Hunyuan3D 2.1**                            | Image-conditioned shape plus separate PBR painting.                                                               | **Restricted optional experiment.** Useful comparator, but not a worldwide asset default under current terms.                                                                     |
| **Hunyuan3D 2.0 / 2mini / 2mv, Fast/Turbo**  | Smaller 2mini image-to-shape variants; 2mv multiview shape; painting separate.                                    | **Restricted optional experiment.** Name the exact shape/paint pair. A shape-only memory result does not establish textured generation.                                           |
| **Stable Fast 3D (SF3D)**                    | Image → UV-unwrapped textured mesh and material estimates.                                                        | **Optional portability comparator.** Official experimental MPS support; needs license acceptance, packaging, and character-detail tests.                                          |
| **TripoSR**                                  | Image → mesh; vertex colors by default, optional baked texture.                                                   | **Experimental older baseline.** Measures the benefit of larger models; not a presumed character-quality fallback.                                                                |
| **Step1X-3D**                                | Separate image-conditioned geometry and texture generation.                                                       | **Watchlist.** Source-build installation burden remains unresolved; do not fund a third integration before comparing the leaders.                                                 |

Sources:
[Pixal3D inference/setup](https://github.com/TencentARC/Pixal3D/blob/f7cf38429b0bd264f1995f0f8743a88b1c728b94/README.md),
[TRELLIS.2 example](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/example.py),
[texturing example](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/example_texturing.py),
[Hunyuan 2.0 model zoo](https://github.com/Tencent-Hunyuan/Hunyuan3D-2),
[SF3D](https://github.com/Stability-AI/stable-fast-3d),
[TripoSR](https://github.com/VAST-AI-Research/TripoSR),
[Step1X-3D](https://github.com/stepfun-ai/Step1X-3D).

**Newer Hunyuan names require different treatment.** Tencent offers **HY-3D 3.0/3.1 through its
hosted API**, with text/image/multiview features. No local checkpoints for those services were
verified here. Calling an API from a Mac is not local inference. **Buffalo 1.0** currently has an
official paper/project-page repository with assets, without an inference/checkpoint release. Neither
belongs in a local-generation commitment.
[TokenHub API, updated 2026-09-29](https://cloud.tencent.com/document/product/1823/137181),
[Buffalo repository](https://github.com/Tencent-Hunyuan/Hunyuan3D-Buffalo1.0)

**Hunyuan3D-Omni and Part** are task-specific options: Omni adds geometry/pose conditioning; Part
offers segmentation and part completion. Skeletal conditioning is not a rigged output. Each has its
own legal files/weights; do not infer terms/hardware by family name. Keep them for later
attachment/control research.
[Omni release/legal files](https://huggingface.co/tencent/Hunyuan3D-Omni/tree/70e803bfb4e127d534049d8ab8c8cb511780d485),
[Part release/legal files](https://huggingface.co/tencent/Hunyuan3D-Part/tree/677174466c53571e8bacd5050dff5948734a1a4d)

Splat-only generators remain outside the standard character path until a declared conversion yields
a triangle mesh passing canonical import and deformation checks. A `.glb` extension alone does not
establish skinnable mesh output.

## Engines and platform reality

A model and inference engine should be separate catalog concepts. Their combination determines
installation, memory, terms, and numerical behavior.

| Implementation                  | Windows NVIDIA, native                              | Windows WSL                                | Linux NVIDIA                                   | Linux AMD                                            | Apple Silicon                                                                                                         | Intel Mac / CPU                                           |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **TRELLIS.2 reference Python**  | SpriteBook adaptation, not upstream's tested target | Linux route to investigate; no local proof | **Upstream tested CUDA target**, source builds | No upstream route verified                           | No upstream MPS/MLX verified                                                                                          | No supported practical route verified                     |
| **Pixal3D reference Python**    | Upstream links community recipes; untested here     | Community route; untested here             | CUDA base plus NATTEN build                    | No upstream route verified                           | No upstream route verified                                                                                            | No supported practical route verified                     |
| **Native ComfyUI, both models** | Implementation exists; qualify GPU/precision/config | Qualify separately                         | Implementation exists                          | Generic ROCm support does not prove all 3D operators | Generic MPS support does not prove complete 3D workflow; **experimental**                                             | No acceptable latency/quality established                 |
| **trellis.cpp, both models**    | **Actual CUDA/Vulkan release archives**             | Usually unnecessary                        | **Actual CUDA/Vulkan archives**                | **ROCm/Vulkan archives**, compatibility varies       | Current source supports Metal; maintainer reports TRELLIS.2 end-to-end. **No Mac archive in examined v0.8.1 release** | CPU backend exists; Intel Mac/throughput unverified       |
| **Hunyuan3D 2.1 upstream**      | README names Windows; setup uses CUDA               | Linux CUDA route to validate               | CUDA-centric setup                             | No full upstream ROCm verified                       | README names macOS, but requirements include CUDA; not proof of MPS PBR                                               | No practical route verified                               |
| **Hunyuan3D mac-rocm port**     | CUDA retained; untested here                        | Not required by native routes              | CUDA retained                                  | Maintainer reports shape/PBR                         | Maintainer reports MPS shape + **256 px PBR**                                                                         | CPU stated, very slow; Intel Mac unqualified              |
| **SF3D upstream**               | **Official experimental**, build tools required     | Linux route to validate                    | CUDA route                                     | No full official validation found                    | **Official experimental MPS**, custom Metal baker                                                                     | Explicit CPU path; Intel Mac installation/latency unknown |

Evidence: [Microsoft prerequisites](https://github.com/microsoft/TRELLIS.2#prerequisites),
[Pixal3D setup](https://github.com/TencentARC/Pixal3D#installation),
[native Comfy nodes](https://github.com/Comfy-Org/ComfyUI/blob/8f04fd6ecf4a548937971e840af2a985529fab76/comfy_extras/nodes_trellis2.py),
[Comfy platforms](https://github.com/Comfy-Org/ComfyUI#installing),
[trellis.cpp v0.8.1 assets](https://github.com/pwilkin/trellis.cpp/releases/tag/v0.8.1),
[current Metal selection](https://github.com/pwilkin/trellis.cpp/blob/8e4ce11a77d35c3e3a4b3f84a29d92bf5491e64e/CMakeLists.txt),
[Hunyuan requirements](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/82920d643c0dc2f7bfd7255f45f62d386edfe60c/requirements.txt),
[mac-rocm port](https://github.com/VladimirTalyzin/hunyuan3d-2.1-mac-rocm),
[SF3D instructions](https://github.com/Stability-AI/stable-fast-3d#support-for-mps-for-mac-silicon-experimental).

**Metal, MPS, and MLX are different claims.** trellis.cpp uses GGML Metal; Python ports use PyTorch
MPS. No MLX implementation is recommended here for complete selected pipelines. A Rust desktop
rewrite does not port CUDA kernels.

The separate **trellis-mac** port reports textured MPS output on an M4 Pro with 24 GB unified
memory. Use it as a comparison if trellis.cpp fails on Apple Silicon, rather than maintaining two
Mac paths immediately. These are maintainer reports, not SpriteBook results.
[Port/requirements](https://github.com/shivampkumar/trellis-mac)

### Proposed support labels

- **Supported:** an exact OS, CPU architecture, GPU/backend, engine revision, file set/configuration
  passes clean-install, artifact, rigging, and sprite tests. Start narrowly with Windows NVIDIA,
  then Linux NVIDIA.
- **Preview:** an upstream/community path exists but SpriteBook qualification is incomplete. Apple
  Silicon and AMD start here, not advertised as equivalent or rejected as impossible.
- **External import:** generate elsewhere and import a mesh; baking still requires a qualified
  renderer. No local AI installation implied.
- **Unavailable:** explain missing capability before download. Synthetic `fixture-gen` is for
  tests/demo, not a customer-facing AI fallback.

**Rigging has a separate portability gap.** The
[UniRig catalog](../packages/registry/catalog/models.json) lists CUDA platforms and a high-memory
Windows non-flash workaround. A Mac generation demo does not establish image-to-animated-sprites.
Preserve imported rigs and canonical-body fitting while investigating generic-rig portability.

## Resources: claims versus measurements

Use **GB for decimal disk bytes**, **GiB for measured memory**. Unified memory is not dedicated
VRAM; record system pressure/swap as well as framework counters.

| Path                                  | Evidence                                                                  | Interpretation                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| TRELLIS.2 reference                   | Upstream requires 24 GB NVIDIA for tested setup                           | Configuration claim, not universal minimum.                                                        |
| SpriteBook `512`, `lowVram=true`      | **Repo:** 3.01 GiB reserved / 2.68 GiB allocated, two August runs         | Adapter-specific; excludes some driver/context/system usage. Not an 8 GB-card qualification.       |
| Same adapter, `lowVram=false`         | **Repo:** 16.53 GiB reserved                                              | One `minVramGb: 12` cannot safely describe both configurations.                                    |
| New Pixal3D/Comfy/trellis.cpp recipes | Implementation/weights exist                                              | Memory/time unknown until each configured path is measured.                                        |
| Hunyuan3D 2.1 reference               | Upstream: 10 GB shape, 21 GB texture, 29 GB combined                      | Gate requested stages, not shape alone.                                                            |
| Hunyuan3D 2.0 reference               | Upstream: 6 GB shape, 16 GB combined                                      | Not measured for every 2mini/resolution/port.                                                      |
| Hunyuan mac-rocm                      | Maintainer: M4 Pro 24 GB, 344 s shape + 512 s safe PBR                    | Reduced-resolution result; qualify quality/system pressure.                                        |
| trellis.cpp Metal                     | Maintainer: M5 24 GB, res-512 textured output in 9:21, 5.6 GB peak RSS    | RSS is not complete unified GPU accounting. No SpriteBook rerun or Pixal3D Mac equivalence.        |
| SF3D                                  | Upstream: default CUDA about 6 GB; MPS recommends CPU below 32 GB unified | Separate experiment with documented constraints.                                                   |
| UniRig                                | **Repo:** 10.0 GiB flash versus 17.4 GiB non-flash at documented mesh cap | Generation progress does not remove rigging bottleneck or justify dropping correctness workaround. |

Sources: [backend proof](../docs/internal/proofs/backends.md),
[measurement discipline](../.agents/skills/sidecar-vram/SKILL.md),
[Hunyuan 2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1),
[Hunyuan 2.0](https://github.com/Tencent-Hunyuan/Hunyuan3D-2),
[mac-rocm results](https://github.com/VladimirTalyzin/hunyuan3d-2.1-mac-rocm#what-works-where),
[trellis.cpp Apple report](https://github.com/pwilkin/trellis.cpp/blob/8e4ce11a77d35c3e3a4b3f84a29d92bf5491e64e/README.md),
[SF3D memory](https://github.com/Stability-AI/stable-fast-3d#manual-inference).

The catalog still contains TRELLIS.2 `minVramGb: 12`, while notes say memory has not been measured;
`lowVram` description cites a different historical peak. Treat this as migration debt, not a
trustworthy default. Configuration, input, adapter, driver and measurement method belong with each
observation. [Catalog](../packages/registry/catalog/models.json)

### Downloads

These are **calculated current-file sums from HF's public API**, not installed-disk measurements.
They exclude environments, archives, staging, caches, outputs, and sometimes auxiliary weights. HF
`usedStorage` can include history and is not an installation-size field.

| Selected files                                    | Approximate download | Caveat                                                                     |
| ------------------------------------------------- | -------------------: | -------------------------------------------------------------------------- |
| Microsoft TRELLIS.2 root checkpoint set           |             16.24 GB | Includes alternate resolutions/encoders; external models still matter.     |
| Tencent Pixal3D single-view, omitting `_mv`       |             24.04 GB | Whole current repo is 46.05 GB; do not silently install multiview.         |
| Comfy TRELLIS.2 INT8 + VAEs + DINOv3 + BiRefNet   |              8.95 GB | Weights only, not runner/image generator.                                  |
| Comfy Pixal3D INT8 + VAEs + DINOv3/NAF + BiRefNet |              9.29 GB | Add ~0.63 GB if chosen workflow uses examined MoGe v1; share common files. |
| Hunyuan3D 2.1 current repo                        |             14.91 GB | Shape/paint, before environment/dependencies.                              |
| 2mini Turbo shape safetensors + VAE               |              4.23 GB | Shape only, excludes duplicate `.ckpt` and other variants.                 |

Evidence: [Microsoft API](https://huggingface.co/api/models/microsoft/TRELLIS.2-4B?blobs=true),
[Pixal3D API](https://huggingface.co/api/models/TencentARC/Pixal3D?blobs=true),
[Comfy TRELLIS](https://huggingface.co/api/models/Comfy-Org/TRELLIS.2?blobs=true),
[Comfy Pixal](https://huggingface.co/api/models/Comfy-Org/Pixal3D?blobs=true),
[BiRefNet](https://huggingface.co/api/models/Comfy-Org/BiRefNet?blobs=true),
[MoGe](https://huggingface.co/api/models/Comfy-Org/MoGe?blobs=true),
[Hunyuan 2.1](https://huggingface.co/api/models/tencent/Hunyuan3D-2.1?blobs=true),
[2mini](https://huggingface.co/api/models/tencent/Hunyuan3D-2mini?blobs=true). Revisions follow
below; installers need per-file hashes/sizes.

## License re-audit

These are engineering eligibility findings from primary legal files, not blanket clearance for every
output/integration. This research installs/bundles nothing.

| Component                        | Verified evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Product consequence                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TRELLIS.2 model/code**         | Microsoft declares both MIT; root legal text is MIT. [License](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/LICENSE)                                                                                                                                                                                                                                                                                                                                                            | Eligible base model, dependencies audited separately.                                                                                                                                                                                  |
| **Pixal3D current code/weights** | GitHub/HF contain MIT text; NOTICE includes Tencent code, parameters and weights, preserving third-party terms. [HF LICENSE](https://huggingface.co/TencentARC/Pixal3D/blob/b0cb2e1b794cab9aa0ac38a95d794a4d9337437f/LICENSE), [NOTICE](https://github.com/TencentARC/Pixal3D/blob/f7cf38429b0bd264f1995f0f8743a88b1c728b94/NOTICE)                                                                                                                                                                                     | Old community claims Pixal3D itself excludes the EU/is non-commercial do not describe this release. Reference runtime still needs audit.                                                                                               |
| **nvdiffrast**                   | Current NVIDIA §3.3 restricts use to non-commercial research/evaluation, except NVIDIA/affiliates. [Legal file](https://github.com/NVlabs/nvdiffrast/blob/main/LICENSE.txt)                                                                                                                                                                                                                                                                                                                                             | Block current reference dependency from commercial-asset default without replacement/separate permission. User-side download does not waive terms.                                                                                     |
| **nvdiffrec**                    | Separate current license restricts use in §3.3. [Legal file](https://github.com/NVlabs/nvdiffrec/blob/main/LICENSE.txt)                                                                                                                                                                                                                                                                                                                                                                                                 | Audit actual calls/imports, including preview/painting; remove from an eligible default recipe.                                                                                                                                        |
| **O-Voxel wheel**                | August proof found no wheel license metadata. Source is inside Microsoft's MIT repository. [Root license](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/LICENSE), [source](https://github.com/microsoft/TRELLIS.2/tree/75fbf0183001ed9876c8dbb35de6b68552ee08bd/o-voxel)                                                                                                                                                                                                         | Missing wheel metadata alone does not establish all source is unlicensed. Establish wheel source/patch/notice correspondence; rasterizer restrictions are separate.                                                                    |
| **DINOv3 conditioning**          | Meta grants worldwide use under custom redistribution/use/trade-control conditions. Not MIT or simply research-only. [Legal file](https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md)                                                                                                                                                                                                                                                                                                                      | Preserve/accept terms separately. Ungated mirrors, quantization and MIT wrapper metadata do not relicense original weights.                                                                                                            |
| **ComfyUI engine**               | Core legal text is GPLv3; replacement mesh-processing source exists. [License](https://github.com/Comfy-Org/ComfyUI/blob/8f04fd6ecf4a548937971e840af2a985529fab76/LICENSE), [processing](https://github.com/Comfy-Org/ComfyUI/blob/8f04fd6ecf4a548937971e840af2a985529fab76/comfy_extras/nodes_mesh_postprocess.py)                                                                                                                                                                                                     | Prefer optional separately installed runner under current posture. Copying nodes into permissive bundled dependencies needs a deliberate decision. Process separation does not erase obligations for distributing ComfyUI/derivatives. |
| **trellis.cpp**                  | Engine, checked-in QEM utility and meshoptimizer texts are MIT; model/encoder terms remain separate. Optional retopology adds dependencies. [Engine license](https://github.com/pwilkin/trellis.cpp/blob/8e4ce11a77d35c3e3a4b3f84a29d92bf5491e64e/LICENSE), [QEM license](https://github.com/pwilkin/trellis.cpp/blob/8e4ce11a77d35c3e3a4b3f84a29d92bf5491e64e/thirdparty/fqms/LICENSE.md), [dependency selection](https://github.com/pwilkin/trellis.cpp/blob/8e4ce11a77d35c3e3a4b3f84a29d92bf5491e64e/CMakeLists.txt) | Strong native-worker candidate. Audit complete binary/submodules/conversion provenance; exclude optional retopology until separately audited. Root MIT is not a binary SBOM.                                                           |
| **Hunyuan3D 2.0/2.1**            | Exact licenses exclude EU/UK/South Korea. §5(c) covers outputs/results outside territory too. Terms include AUP, redistribution, restrictions on improving other AI models, and release-date 1M-MAU commercial trigger. [2.0 legal file](https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/f8db63096c8282cb27354314d896feba5ba6ff8a/LICENSE), [2.1 weights license](https://huggingface.co/tencent/Hunyuan3D-2.1/blob/0b94677654c57bb9a6b6845cd7b704ccf551d327/LICENSE)                                               | **Block as worldwide game-asset default.** Install gates alone do not resolve distribution to players worldwide. Optional use needs exact terms/output assessment; an MIT wrapper does not change model terms.                         |
| **SF3D**                         | Stability Community License permits limited commercial use with registration/revenue conditions, attribution/AUP. [Legal file](https://github.com/Stability-AI/stable-fast-3d/blob/ff21fc491b4dc5314bf6734c7c0dabd86b5f5bb2/LICENSE.md)                                                                                                                                                                                                                                                                                 | Optional gated model, neither universally non-commercial nor unconditional permissive default.                                                                                                                                         |
| **TripoSR / Step1X-3D**          | Root texts MIT / Apache-2.0 respectively, without automatically clearing dependencies/weights. [TripoSR](https://github.com/VAST-AI-Research/TripoSR/blob/main/LICENSE), [Step1X](https://github.com/stepfun-ai/Step1X-3D/blob/cb5ac944709c6c913109070c7b90c3447f57f3d4/LICENSE)                                                                                                                                                                                                                                        | Expand beyond leading pipelines only if product tests justify it.                                                                                                                                                                      |

The current adapter blocks eager access to gated **BRIA RMBG-2.0**, using SpriteBook's preflight
removal. Preserve that protection. Every runner recipe must declare matting, camera estimation,
image encoders and VAEs before installing. Replacing CUDA extensions does not fix surprise auxiliary
downloads. [Existing guard](../sidecar/spritebook_sidecar/adapters/trellis2.py),
[Pixal3D inference](https://github.com/TencentARC/Pixal3D/blob/f7cf38429b0bd264f1995f0f8743a88b1c728b94/inference.py)

## Runner recommendation

**Keep a SpriteBook-owned job boundary and evaluate existing engines behind it.** Core owns
manifests, provenance, caching, cancellation, acceptance and canonical import. Engines execute
models. Comfy graphs/vendor Python types should not become project formats.

1. **First native spike: trellis.cpp CLI/resident server**, not its desktop app. It has
   Windows/Linux binaries, both model families and a current Metal route. Validate releases
   separately from newer source. Prefer controlled conversions from verified official weights over
   trusting arbitrary converted HF repositories.
   [Engine/server](https://github.com/pwilkin/trellis.cpp),
   [Pixal3D implementation](https://github.com/pwilkin/trellis.cpp/blob/8e4ce11a77d35c3e3a4b3f84a29d92bf5491e64e/docs/pixal3d/README.md)
2. **First Python spike: native ComfyUI**, explicitly versioned/separately installed, with one
   curated API workflow. Allow connecting an existing installation. Do not require a graph UI,
   arbitrary custom nodes or marketplace for SpriteBook's main journey.
   [Official template](https://docs.comfy.org/tutorials/3d/trellis2)
3. **Choose one supported default recipe per platform after comparison.** Supporting both engines
   indefinitely doubles qualification. Keep another only if it solves a demonstrated gap.

Pin engine/workflow/files, use loopback and allowlisted adapter operations, bind jobs to owned
output directories, validate paths/artifacts, and cancel owned work without killing unrelated jobs.
Retain the existing authenticated/versioned boundary, retryable errors, logs and artifact
validation. Local runners execute code.
[Existing sidecar contract](../docs/architecture/architecture.md#sidecar-contract-specified-implemented-p3-t2)

**Proposed provenance fields to decide during schema design:** engine revision, workflow hash, model
hashes/revisions, precision/quantization, backend/GPU/driver, auxiliary models, requested/effective
parameters, seeds/retries, memory method/peak, system pressure, cold/warm time, raw hash and
canonical-import report. Recipe changes invalidate generation caches.

## Benchmark before choosing a default

**Pilot:** four owned/consented characters × three seeds per candidate. Compare Pixal3D/TRELLIS.2
through native and Python engines on Windows NVIDIA first: plain humanoid, asymmetric
tattoo/prosthetic, layered clothing/long hair, thin features. Investigate structural/license
failures before expanding.

**Qualification:** twelve characters covering real roster diversity, then Linux NVIDIA, Apple
Silicon and a named AMD target. Compare at equal sprite output size as well as equal 3D settings. A
seed is provenance, not equivalent sampling between model families.

| Dimension          | Evidence                                                                             | Promotion gate                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Identity/asymmetry | Correct side of marks/prosthetics/accessories; front/side/back silhouette            | Blinded review at actual sprite sizes; no implicit mirroring; report failures individually.                 |
| Materials          | Color, alpha, metallic/roughness distributions, seams, baked lighting                | Detect dark/all-metal collapse; preserve raw outputs. Glossy turntables are not primary acceptance.         |
| Geometry           | Finite positions/indices; components; UVs; feet/height/front; thin details           | Canonical import succeeds with report; details survive. Face count alone is not quality.                    |
| Rigging            | Track A/B and imported rigs; hips/shoulder/elbow/knee tests                          | Finite normalized weights; deformation passes or explicit repair required. Pose conditioning is not rig QA. |
| Sprites            | Directions, idle/walk/crouch, 32/64/128 px cells, lit/albedo/normal/mask             | Readable identity, no clipping, correct AOV layout/pivots, player review and temporal metric.               |
| Resources          | Clean install, disk/staging, interrupted downloads, cold/warm time, peak memory/swap | Config-specific preflight; no compiler for supported end-user installs; honest failure.                     |
| Reproducibility    | Repeat inputs/seed/config/machine                                                    | Validate determinism or label exception before promotion; no cross-engine/GPU byte promise.                 |
| Batches            | 10 then 100 characters; cancellation/retry/death; residency                          | Resume without corrupt manifests/receipts; record failures and warm throughput.                             |

Use [existing product budgets](../docs/prd.md#success-metrics): image-to-engine ≤30 min,
mesh-to-sheet ≤10 min, 100-character style pivot overnight. Report median/worst time, success rate,
retries and repair time separately. Retain measured material-collapse cases; an engine change may
alter failure frequency without curing a model.

**Selection rule:** among legally eligible recipes passing deformation and final-sprite quality,
choose the smallest installation and least maintenance meeting the budget. Keep heavier optional
models only for character classes the default demonstrably fails.

## Exact upstream snapshot

These are **research anchors, not approved installation pins**. Public APIs were read on 2026-10-18.
Future recipes also need per-file SHA-256/bytes. Versioned source links identify inspected contents;
other `main` links aid navigation.

| Hugging Face repository                                                                                                           | Revision examined                          |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [microsoft/TRELLIS.2-4B](https://huggingface.co/microsoft/TRELLIS.2-4B/tree/af44b45f2e35a493886929c6d786e563ec68364d)             | `af44b45f2e35a493886929c6d786e563ec68364d` |
| [TencentARC/Pixal3D](https://huggingface.co/TencentARC/Pixal3D/tree/b0cb2e1b794cab9aa0ac38a95d794a4d9337437f)                     | `b0cb2e1b794cab9aa0ac38a95d794a4d9337437f` |
| [Comfy-Org/TRELLIS.2](https://huggingface.co/Comfy-Org/TRELLIS.2/tree/430a9d09b2416687018c8fe8edced2ad4858a439)                   | `430a9d09b2416687018c8fe8edced2ad4858a439` |
| [Comfy-Org/Pixal3D](https://huggingface.co/Comfy-Org/Pixal3D/tree/f37641be376725d324c56626007cc477f1249a69)                       | `f37641be376725d324c56626007cc477f1249a69` |
| [Comfy-Org/BiRefNet](https://huggingface.co/Comfy-Org/BiRefNet/tree/25511f8787e51912e1480706b4e47b8f467fbf72)                     | `25511f8787e51912e1480706b4e47b8f467fbf72` |
| [Comfy-Org/MoGe](https://huggingface.co/Comfy-Org/MoGe/tree/1484985258ba7ef45c314144fcf0e90924ffbf44)                             | `1484985258ba7ef45c314144fcf0e90924ffbf44` |
| [tencent/Hunyuan3D-2.1](https://huggingface.co/tencent/Hunyuan3D-2.1/tree/0b94677654c57bb9a6b6845cd7b704ccf551d327)               | `0b94677654c57bb9a6b6845cd7b704ccf551d327` |
| [tencent/Hunyuan3D-2](https://huggingface.co/tencent/Hunyuan3D-2/tree/9cd649ba6913f7a852e3286bad86bfa9a2d83dcf)                   | `9cd649ba6913f7a852e3286bad86bfa9a2d83dcf` |
| [tencent/Hunyuan3D-2mini](https://huggingface.co/tencent/Hunyuan3D-2mini/tree/f90a0f7df7d5e6f71109cf333f6a95a0ae3194a6)           | `f90a0f7df7d5e6f71109cf333f6a95a0ae3194a6` |
| [tencent/Hunyuan3D-2mv](https://huggingface.co/tencent/Hunyuan3D-2mv/tree/3a761b539b29fe4ff64714813aa9560fd66f5de0)               | `3a761b539b29fe4ff64714813aa9560fd66f5de0` |
| [microsoft/TRELLIS-text-large](https://huggingface.co/microsoft/TRELLIS-text-large/tree/4aad9f4a110329a410974d7f41ce5333a9a1fc87) | `4aad9f4a110329a410974d7f41ce5333a9a1fc87` |
| [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo/tree/f332072aa78be7aecdf3ee76d5c247082da564a6)         | `f332072aa78be7aecdf3ee76d5c247082da564a6` |
| [stabilityai/stable-fast-3d](https://huggingface.co/stabilityai/stable-fast-3d/tree/f0c9a8ffd62cb1bbc8a7a53c9f87a0be1b6be778)     | `f0c9a8ffd62cb1bbc8a7a53c9f87a0be1b6be778` |
| [stabilityai/TripoSR](https://huggingface.co/stabilityai/TripoSR/tree/5b521936b01fbe1890f6f9baed0254ab6351c04a)                   | `5b521936b01fbe1890f6f9baed0254ab6351c04a` |
| [stepfun-ai/Step1X-3D](https://huggingface.co/stepfun-ai/Step1X-3D/tree/bf7084495b3a72222f36549b7942948aa4d9daa7)                 | `bf7084495b3a72222f36549b7942948aa4d9daa7` |

Source revisions:
[TRELLIS.2 `75fbf018`](https://github.com/microsoft/TRELLIS.2/tree/75fbf0183001ed9876c8dbb35de6b68552ee08bd),
[Pixal3D `f7cf3842`](https://github.com/TencentARC/Pixal3D/tree/f7cf38429b0bd264f1995f0f8743a88b1c728b94),
[ComfyUI `8f04fd6e`](https://github.com/Comfy-Org/ComfyUI/tree/8f04fd6ecf4a548937971e840af2a985529fab76),
[trellis.cpp `8e4ce11a`](https://github.com/pwilkin/trellis.cpp/tree/8e4ce11a77d35c3e3a4b3f84a29d92bf5491e64e),
[Hunyuan 2.1 `82920d64`](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/tree/82920d643c0dc2f7bfd7255f45f62d386edfe60c),
[MPS/ROCm port `6f4b63bd`](https://github.com/VladimirTalyzin/hunyuan3d-2.1-mac-rocm/tree/6f4b63bd6419406f40291bca23a7c849bcaae2a3),
[trellis-mac `d58628f4`](https://github.com/shivampkumar/trellis-mac/tree/d58628f4f5b9c3de8274cb110074154f4b31cef2).

No new weights, binaries, GPU kernels or generation jobs were exercised. Mac/AMD support,
sprite-quality comparisons, complete binary licensing, and resource floors remain qualification
work; none is newly certified by this document.
