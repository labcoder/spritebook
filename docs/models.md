# Models and local runtimes

The shipped catalog has five entries. Model management covers image preparation, generation and
generic rigging. Textures can come from generation, TRELLIS.2 retexturing or core detail
reprojection; animation packs and sprite styles are separate assets and code.

The catalog in [`packages/registry/catalog/models.json`](../packages/registry/catalog/models.json)
defines exact files, versions, capabilities, terms, platform gates, parameters and memory admission.
Use `spritebook models list` for the current catalog and `spritebook models list --installed` for
the local weight receipts. A catalog entry is available to install; it is not downloaded with the
application.

## Current model catalog

| ID            | Role                                                | Complete managed version | Model files | GPU admission                                         |
| ------------- | --------------------------------------------------- | ------------------------ | ----------- | ----------------------------------------------------- |
| `trellis2-4b` | Default image → textured/PBR mesh; mesh retexturing | `af44b45f.local1`        | 17.60 GB    | NVIDIA/CUDA; measured configurations require 4–18 GiB |
| `pixal3d`     | Optional single-image → PBR mesh                    | `b0cb2e1b.local1`        | 25.26 GB    | NVIDIA/CUDA; 24 GiB card admission                    |
| `unirig`      | Track B skeleton prediction and skin weights        | `36842e2b.local1`        | 5.82 GB     | NVIDIA/CUDA; 17.4 GiB                                 |
| `rembg-u2net` | CPU background removal for `gen` and `prep`         | `1.0.0`                  | 0.18 GB     | None                                                  |
| `fixture-gen` | Synthetic stand-in for exercising the pipeline      | `1.0.0`                  | None        | None                                                  |

Sizes are decimal GB for declared model files, excluding Python, native wheels, caches, staging and
generated assets. VRAM values are admission claims for configured paths, not universal model
minimums. Pixal3D's measured worker reached 24.15 GiB working set and 46.87 GiB private commit on
the 64 GiB host; see the [qualification](../future/qualification/pixal3d-windows-x64.json) for
limits.

The complete CUDA recipes above have Windows x64 / RTX 3090 qualification. Earlier TRELLIS.2 and
UniRig versions remain in the catalog for provenance and explicit pins; their historical
Windows/Linux platform declarations do not provide the complete managed setup recipe. Native Mac,
Linux and Windows ARM64 application qualification remains F7 work. The
[platform spike](../future/model-platform-spike.md) lists promising model ports and their reported
requirements; TripoSR, Hunyuan3D, SF3D and SPAR3D are not integrated catalog choices.

## What works without a model download

- Import a mesh, including an already rigged model, through the canonical glTF border.
- Track A fits a bundled CC0 body; `ubc-male` is the portable default. Explicit body directories
  remain supported, including the bundled `ubc-female` directory.
- The bundled CC0 animation pack supplies clips. Personal animation imports retain their own
  provenance and redistribution terms.
- Core handles retargeting, palettes, outlines, NPR styles, rendering, packing and exports. These
  are not neural model installations. Baking still needs a working WebGPU adapter.
- Detail reprojection and colour matching use core image processing. A fresh model install is
  required for neural retexturing, not for these operations.

Pixal3D currently exposes single-view generation, manual camera FOV and one to eight candidates. It
does not expose a separate retexturing or multi-view path. There is no current text-to-image or
text-to-3D catalog entry. `fixture-gen` proves the workflow; it is not a likeness generator.

Generation prepares opaque references automatically through the installed U²-Net model. A valid
transparent 8-bit RGBA PNG needs no preparation model. The source reference remains unchanged; core
records the cutout hash, exact preparation model and parameters and reuses that verified artifact on
retry. Missing weights are an actionable model gate, never a silent download.

## Install and repair

Studio's **Manage models** dialog shows one recommended build per model for the detected platform,
preferring a managed runtime recipe. **Other versions** retains earlier builds and their install
state for existing pins. The `.local1` suffix identifies SpriteBook's complete managed build, with
runtime setup and required support files; it is not a second model trained by SpriteBook. Exact
build IDs, platform declarations, terms and notes live under **Details**.

Downloaded weights and runtime preparation are separate states. **Runtime setup required** offers
setup directly; **Ready** means the weight receipt and prepared runtime are present. This is not a
fresh inference or continuous dependency-integrity check. **Verify files**, **Repair runtime** and
**Remove** are available under **Details**. The same operations are available on the CLI:

```sh
spritebook models install rembg-u2net
spritebook models install unirig@36842e2b.local1
spritebook models install trellis2-4b@af44b45f.local1 --accept-license
spritebook models install pixal3d@b0cb2e1b.local1 --accept-license
spritebook models verify pixal3d
spritebook models setup pixal3d@b0cb2e1b.local1 --accept-license
```

For an installed version with a declared runtime recipe, Studio offers **Repair runtime**. Review
the CLI twin, accept the declared terms when required, then choose **Confirm runtime setup**. This
runs `models setup`, retaining model files while repairing source/dependencies. It can download code
and wheels; **Verify files** remains a separate model-file check.

TRELLIS.2 and Pixal3D require personal Hugging Face approval for the declared DINOv3 conditioner,
authentication through `hf auth login` or `HF_TOKEN`, and explicit acceptance of the catalog terms.
Hugging Face supplies artifacts and authentication; SpriteBook has no Hugging Face desktop-app
dependency. Read [licensing](licensing.md) for component and output terms.

`install` verifies every declared model file and records its receipt, then prepares a declared
runtime recipe. Setup downloads hash-pinned source and frozen prebuilt wheels, installs the owned
sidecar package as a normal wheel, checks native modules and publishes `ready.json`. The selected
Windows recipes use managed Python 3.11.16; the installed application supplies uv 0.12.10.

An interrupted setup retains verified model files. `models setup` repairs the runtime and repeats
readiness checks. `models verify` checks model files; an installed weight receipt alone does not
prove runtime readiness. An empty Python environment left after dependency cleanup is not treated as
prepared, even when its old source receipt remains. UniRig setup validates Blender in a disposable
process by checking a real mesh artifact, alongside its CUDA and rendering checks.

Historical weights-only versions do not have managed setup. Install the current complete version;
for UniRig, the existing checkpoints can supply it without downloading those files again:

```sh
spritebook models install unirig@36842e2b.local1 --from <models-root>/unirig/36842e2b
```

`--from <dir>` supplies model files offline; source and wheel provisioning still need network access
unless separately cached. Once prepared, the qualified workflows run with inference networking
blocked.

Installation shows activity as soon as it starts. File downloads report bytes received and the
current filename; runtime preparation shows extraction, dependency installation, service preparation
and native checks. Stages with no known byte total use an indeterminate indicator. Raw diagnostics
remain in the log drawer; failures keep their reason available under **Show error**. **Cancel job**
stops the owned job, and the refreshed inventory shows which verified files remain.

In the NDJSON stream, `download-bytes:<file>` and `setup:download-bytes:<file>` use byte counts for
`done`/`total`. The existing `download:<file>` completion events count verified files. Runtime phase
events use `0/1` while running; they do not represent a percentage or ETA.

Before a model job, core resolves exact project pins and rechecks consent, territory, platform,
files and configuration-specific VRAM admission. Native runtime loading also verifies prepared
source receipts. See [execution policy](architecture/execution-policy.md).

## Storage and removal

| Data                         | Windows default                                            | Ownership                                                                         |
| ---------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Weights and install receipts | `%LOCALAPPDATA%/spritebook/models/<id>/<version>`          | Per-machine, outside workspaces; `SPRITEBOOK_MODELS_DIR` overrides only this root |
| Base sidecar environment     | `%LOCALAPPDATA%/spritebook/runtime/sidecar-<lock hash>`    | Shared by model operations using that sidecar lock                                |
| Prepared model runtimes      | `%LOCALAPPDATA%/spritebook/runtime/<recipe>-<fingerprint>` | Source/native readiness receipt and, for isolated recipes, its `.venv`            |
| Working assets               | Your workspace directory                                   | Source/results, canonical revisions, rig data, bakes and exports                  |

The corresponding data roots are `~/Library/Application Support/spritebook` on macOS and
`$XDG_DATA_HOME/spritebook` (default `~/.local/share/spritebook`) on Linux. These paths describe
storage conventions, not qualified native model support. Source development ordinarily uses
`sidecar/.venv`; `UV_PROJECT_ENVIRONMENT` can override environment placement. uv-managed Python,
shared wheel caches and optional Hugging Face caches have their own locations.

```sh
spritebook models rm pixal3d                 # every installed version of this model
spritebook models rm unirig@36842e2b.local1  # only this version
spritebook models list --installed
```

`models rm` and Studio's **Remove** delete model files and their receipt. They preserve runtime
environments, shared caches, credentials and all workspace assets. Picking a saved result,
undo/redo, rendering an accepted mesh and exporting existing bakes do not require its generator to
remain installed.

For a complete dependency reset, first close Studio and its CLI/model workers. Remove the desired
models through `models rm`, then remove only SpriteBook-owned runtime/environment directories. The
base sidecar environment can be shared by several models, so removing it requires setup before any
of those models run again. Clear only identified app-specific cache entries; preserve shared tool
installations, authentication and unrelated repositories. Never delete `character.json`, canonical
revisions, bake directories or workspace lock files as a model reset.

To resume source development after removing `sidecar/.venv`, use the frozen setup in
[the sidecar guide](../sidecar/README.md). To resume a downloaded model workflow, reinstall its
model files and run the declared setup. Rust build cleanup is separate: contributors can use `cargo
clean --manifest-path apps/studio/src-tauri/Cargo.toml` and `cargo clean --manifest-path
packages/core/native/Cargo.toml`; clean any custom Cargo target directories with their explicit
`--target-dir` as well.

## UniRig quality checks

Adapter 1.3.0 checks humanoid naming against leg, trunk and arm ancestry as well as position. A
close reference match cannot place a thigh in the spine; contradictory finger-chain labels stay
generic and produce a warning. Corrections and rejected names are recorded in `rig/rig-run.json`. A
named joint or finite, normalized weight row does not prove correct anatomy.

The CPU merge interpolates nearby samples, attenuates influence from distant bones, and smooths
weights along mesh edges with nonnegative, anchored updates. Geometric seam copies share weights;
disconnected surfaces do not exchange them. The four-influence reduction fades the discarded tail
so neighboring vertices do not suddenly lose a substantial influence when rankings cross. The
former hierarchical diffusion could produce negative parent weights; clipping those and applying
a hard influence cutoff created jagged shoulders during motion. Smoothing uses SciPy already in
the runtime, with no additional download. Neither transfer nor position hints can recover detail
missing from the model prediction. Deformation thresholds are unchanged.

Existing rigs retain their saved bytes. Rebuilding uses the updated adapter without downloading
checkpoints again. The saved Bulma skeleton reproduces the corrected hip/trunk/leg naming on CPU;
fresh GPU runs, remaining deformation findings and viewport measurements are recorded in the
[roadmap follow-through](../future/roadmap.md#rig-correctness-and-interaction-follow-through).

Animation preview and bake check mapped bone ancestry before transferring motion. Contradictory
names (for example, a thigh named `pelvis`) refuse with a request to rebuild the rig. Accepting a
deformation report records review; it does not rename bones or repair saved weights.
