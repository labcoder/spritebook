# Licensing

This page collects the license facts that matter when you ship work made with SpriteBook. It covers
SpriteBook's own license, the bundled assets, the on-demand models, and the known traps.

## 1. SpriteBook and exported assets

SpriteBook's code uses AGPL-3.0-only. The output exception in [NOTICE](../NOTICE) says that
spritesheets, atlases, manifests, models and other assets produced by running SpriteBook are not
subject to the AGPL solely because SpriteBook produced them. The exception does not grant rights to
an input character, imported clip or downloaded model component; their own terms still apply.

The `NOTICE` file carries these items:

- the copyright statement
- the output exception
- a clause on dual-licensing availability
- an attribution request with a suggested credit line — the request is not binding
- a trademark note

## 2. What ships in the box

The dependency policy permits MIT, Apache-2.0, BSD, ISC, OFL and CC0 third-party components, with
CC0 clips in the bundled animation pack. The [BOM](developer/dependencies.md) records exact pins,
component notices and remaining distribution-clearance checks. SpriteBook itself retains its AGPL
license.

| Bundled item                                                         | Content                                                                                                   | License                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Universal Animation Library (UAL) 1 and 2, free tiers, by Quaternius | 86 clips as bundled, with 8-direction locomotion and root motion                                          | CC0                          |
| Canonical Track A bodies                                             | two rigged bodies at `packages/rig/bodies/`, seeded from the Universal Base Characters pack by Quaternius | ours; the source pack is CC0 |
| Test-pose pack                                                       | poses for rig deform checks                                                                               | CC0, derived from the UAL    |
| `fixture-gen`                                                        | a synthetic gen3d backend: no download, no GPU, no weights                                                | MIT, part of SpriteBook      |

Paid UAL Source packs are not bundled. Personal imports retain their own terms. The synthetic
`fixture-gen` backend exists for development; it does not establish native desktop or model support
on another platform.

## 3. Models install on demand, behind gates

AI model weights are never bundled. Each backend is catalog data, never a hardcoded integration.
Each catalog entry carries these facts:

- the license, whether it needs acceptance, and its excluded territories
- the platforms each version runs on
- the measured VRAM floor, when one was measured
- the parameter schema for jobs

At install time, your machine downloads the model files and checks them against pinned sha256
hashes. Four gates run at install time:

| Gate               | What it means                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License acceptance | When a license needs explicit acceptance, the install stops until you pass `--accept-license`. Your acceptance is recorded in the install receipt.                                                    |
| Territory          | When a license excludes territories, declare yours with `--territory <ISO code>`. The declaration is recorded; SpriteBook never geolocates you. A declared territory on the excluded list is refused. |
| Platform           | A CUDA-only version is refused on a machine without an NVIDIA GPU, with both sides named.                                                                                                             |
| VRAM               | The catalog carries measured floors, never README claims. At install time this gate warns only; the job-time preflight is the hard gate.                                                              |

You see the terms before an install. `spritebook models list` lists each entry with its license and
its excluded territories. The models pane in the GUI shows the license and, when acceptance is
needed, an acceptance box. A failed gate prints a message that names the exact flag to use.

The catalog today:

| Entry         | Role                   | License                                                                                                                                                      |
| ------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rembg-u2net` | background removal     | Apache-2.0 for the `u2net.onnx` weights; the rembg tool itself is MIT                                                                                        |
| `unirig`      | generic auto-rig       | MIT code/weights. Complete `local1` uses owned architecture data instead of the historical restricted OPT config. External dependencies have separate terms. |
| `trellis2-4b` | image to textured mesh | MIT model/source plus the separately accepted custom DINOv3 conditioner agreement. Read the selected runtime terms below.                                    |
| `pixal3d`     | image to textured mesh | MIT model/source, Apache-2.0 NAF and the same custom DINOv3 agreement. Read the selected runtime terms below.                                                |
| `fixture-gen` | synthetic backend      | MIT, part of SpriteBook                                                                                                                                      |

## 4. The selected TRELLIS.2 and Pixal3D stacks

The current Windows recipes replace the historical NVIDIA `nvdiffrast`/`nvdiffrec_render`
evaluation-only rasterizers with MIT DRTK. Their traced O-Voxel build retains MIT and Eigen MPL-2.0
notices/source correspondence. CuMesh and FlexGEMM are MIT. Pixal3D additionally uses MIT NATTEN,
its BSD-licensed CUTLASS components, and the Apache-2.0 NAF model. These are external downloads, not
bundled application dependencies. Exact source, wheel, agreement and notice pins are in the
[BOM](developer/dependencies.md), [runtime recipes](../sidecar/runtimes) and
[F4 gate record](../future/model-provisioning-gate.md).

The earlier runtime's restricted rasterizers and untraced wheel are absent from these selected
recipes. That does not clear arbitrary upstream environments, community binaries or old installs.
Use the complete catalog versions and their frozen runtimes; preserve each component's terms.
UniRig's external Blender/GPL components also retain their separate obligations.

Both generators require Meta's gated `facebook/dinov3-vitl16-pretrain-lvd1689m`. Request personal
access on Hugging Face and authenticate, then explicitly accept the catalog's declared terms.
Installation verifies the official config, weights and
[August 19, 2025 agreement at revision `ea8dc286`](https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m/blob/ea8dc2863c51be0a264bab82070e3e8836b02d51/LICENSE.md).
It is a custom agreement with use, redistribution and trade-control conditions. The selected text
differs from the older website agreement; apply the exact installed agreement rather than an old
attribution summary. An MIT model badge or converted checkpoint does not relicense this conditioner.

The catalog records acceptance and file hashes; the adapters load only those declared local files.
They do not download upstream BRIA matting models or silently switch to mirrors. Windows runtime
qualification is separate from permission to redistribute every model/runtime in an installer. The
application still bundles no model weights.

## 5. Mixamo and the other clip traps

The Mixamo terms let you use the clips in your projects. The terms do not let anyone redistribute
the clips. Thus SpriteBook never bundles Mixamo clips. You import your own Mixamo clips, and
SpriteBook uses them in your workspace only. The rule: user imports are used, never redistributed.

| Source                       | Terms                                   | SpriteBook posture                                  |
| ---------------------------- | --------------------------------------- | --------------------------------------------------- |
| Mixamo                       | usable in projects; not redistributable | personal user import only; never bundled            |
| AMASS and the SMPL family    | research-only                           | not used                                            |
| Ubisoft LAFAN1               | non-commercial research                 | not used                                            |
| Bandai Namco motion datasets | CC-BY-NC                                | not used                                            |
| CMU mocap                    | free for any use                        | possible later import path; not the bundled starter |

## 6. The license files govern

This page is a summary; the license files govern.
