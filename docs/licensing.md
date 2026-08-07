# Licensing

This page collects the license facts that matter when you ship work made with SpriteBook. It covers
SpriteBook's own license, the bundled assets, the on-demand models, and the known traps.

## 1. Your sprites are yours

SpriteBook's own license is AGPL-3.0-only with an output exception. Decision D-019 records this
license. The exception says: "spritesheets/atlases/manifests/models produced by running SpriteBook
are not subject to the AGPL". In plain terms: the output you bake is yours. You can sell it. The
AGPL applies to SpriteBook's code, not to your spritesheets.

The `NOTICE` file carries these items:

- the copyright statement
- the output exception
- a clause on dual-licensing availability
- an attribution request with a suggested credit line — the request is not binding
- a trademark note

## 2. What ships in the box

Everything bundled with SpriteBook is under MIT, Apache-2.0, BSD, ISC, OFL, or CC0. Decision D-013
sets the rule for clips: bundle CC0 clips only.

| Bundled item                                                         | Content                                                                                                   | License                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Universal Animation Library (UAL) 1 and 2, free tiers, by Quaternius | about 120–130 clips, with 8-direction locomotion and root motion                                          | CC0                          |
| Canonical Track A bodies                                             | two rigged bodies at `packages/rig/bodies/`, seeded from the Universal Base Characters pack by Quaternius | ours; the source pack is CC0 |
| Test-pose pack                                                       | poses for rig deform checks                                                                               | CC0, derived from the UAL    |
| `fixture-gen`                                                        | a synthetic gen3d backend: no download, no GPU, no weights                                                | MIT, part of SpriteBook      |

The paid UAL Source packs are not bundled; they come in through one-click user import. `fixture-gen`
is the reason a macOS or win-arm64 user gets a working app with no AI generation, not a broken one.

## 3. Models install on demand, behind gates

AI model weights are never bundled. Decision D-009 makes each backend catalog data, never a
hardcoded integration. Each catalog entry carries these facts:

- the license, whether it needs acceptance, and its excluded territories
- the platforms each version runs on
- the measured VRAM floor, when one was measured
- the parameter schema for jobs

At install time, your machine downloads the model files and checks them against pinned sha256
hashes. Four gates run at install time:

| Gate               | What it means                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License acceptance | When a license needs explicit acceptance, the install stops until you pass `--accept-license`. Your acceptance is recorded in the install receipt.                                                            |
| Territory          | When a license excludes territories, declare yours with `--territory <ISO code>`. The declaration is recorded; SpriteBook never geolocates you (D-027). A declared territory on the excluded list is refused. |
| Platform           | A CUDA-only version is refused on a machine without an NVIDIA GPU, with both sides named.                                                                                                                     |
| VRAM               | The catalog carries measured floors, never README claims. At install time this gate warns only; the job-time preflight is the hard gate.                                                                      |

You see the terms before an install. `spritebook models catalog` lists each entry with its license
and its excluded territories. The models pane in the GUI shows the license and, when acceptance is
needed, an acceptance box. A failed gate prints a message that names the exact flag to use.

The catalog today:

| Entry         | Role                   | License                                                                                                                |
| ------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `rembg-u2net` | background removal     | Apache-2.0 for the `u2net.onnx` weights; the rembg tool itself is MIT                                                  |
| `unirig`      | generic auto-rig       | MIT for code and weights. One small config file comes from Meta's `facebook/opt-350m` repo; the MIT does not cover it. |
| `trellis2-4b` | image to textured mesh | MIT for the weights — read the next section before commercial use                                                      |
| `fixture-gen` | synthetic backend      | MIT, part of SpriteBook                                                                                                |

## 4. The TRELLIS.2 stack, honestly

The TRELLIS.2 4B weights are MIT, and the catalog is right about that. The stack under them is not
clean. The adapter needs five prebuilt CUDA extension wheels to run. Three of the five block
commercial use or grant no rights at all. The licenses below were read from each installed
`dist-info/` directory, not from a project page.

| Wheel                    | License                                       | Effect                                                                                                                     |
| ------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `nvdiffrast` 0.4.0       | Nvidia Source Code License (1-Way Commercial) | non-commercial: §3.3 limits use to "research or evaluation purposes only and not for any direct or indirect monetary gain" |
| `nvdiffrec_render` 0.0.0 | NVIDIA Source Code License for nvdiffrec      | non-commercial: same §3.3 limitation                                                                                       |
| `o_voxel` 0.0.1          | none declared                                 | all rights reserved by default                                                                                             |
| `cumesh` 1.0             | MIT                                           | clear                                                                                                                      |
| `flex_gemm` 0.0.1        | MIT                                           | clear                                                                                                                      |

SpriteBook does not bundle these wheels. Only the sha256 pins are committed. Your machine fetches
the wheels at install time, the same way it fetches model weights.

The encumbered code is on the happy path, not on an optional branch. Every gen3d run calls
`o_voxel.postprocess.to_glb`. That function imports nvdiffrast and calls `dr.rasterize` and
`dr.interpolate` for the texture bake.

What this means for commercial use today: the NVIDIA terms do not let you use these components for
monetary gain. `o_voxel` grants no rights at all. Every gen3d run uses all three. Do not treat gen3d
output as cleared for commercial work today. SpriteBook's output exception cannot lift this. The
restriction is the licensor's, and only the licensor can lift it.

This is not special to TRELLIS.2. An MIT badge on a generative-3D repo describes the model, not the
stack. The D-036 survey found no gen3d backend that passes all four ship gates. Every alternative
fails earlier: territory carve-outs, Tencent components, or source-only builds. The survey rows are
in [`docs/dependencies.md`](./dependencies.md).

Decision D-036, item 4, records a replacement for the encumbered stage as future work, not as done
work. `o_voxel.postprocess.to_glb` is the single nvdiffrast call site on our path. The function does
a UV unwrap and a texture bake. SpriteBook already has a WebGPU render core and a glTF pipeline for
that work. Until that replacement lands, the limitation above stands.

One more gate on this backend: one prerequisite cannot be auto-installed. The image conditioner is
Meta's gated `facebook/dinov3-vitl16-pretrain-lvd1689m` repo. Request access from Meta and supply a
Hugging Face token. Its license lets commercial use and redistribution, but you must display "Built
with DINOv3".

## 5. Mixamo and the other clip traps

The Mixamo terms let you use the clips in your projects. The terms do not let anyone redistribute
the clips. Thus SpriteBook never bundles Mixamo clips. You import your own Mixamo clips, and
SpriteBook uses them in your workspace only. Decision D-013 records the rule: user imports are used,
never redistributed.

| Source                       | Terms                                   | SpriteBook posture                                  |
| ---------------------------- | --------------------------------------- | --------------------------------------------------- |
| Mixamo                       | usable in projects; not redistributable | personal user import only; never bundled            |
| AMASS and the SMPL family    | research-only                           | not used                                            |
| Ubisoft LAFAN1               | non-commercial research                 | not used                                            |
| Bandai Namco motion datasets | CC-BY-NC                                | not used                                            |
| CMU mocap                    | free for any use                        | possible later import path; not the bundled starter |

## 6. The license files govern

This page is a summary; the license files govern.
