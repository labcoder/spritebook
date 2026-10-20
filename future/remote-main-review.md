# Reconciling the independent remote history

**Decision, 2026-10-19:** keep the local TypeScript/Node core and Tauri application as the
authoritative `main`. Adapt useful remote behavior through the existing manifest/CLI contracts; do
not merge the alternate implementation wholesale. The maintainer requested one clean main branch
after reviewing and retaining useful work.

## What was on origin

The inspected remote head was `f1f6e39293cec7726244c7bfbefab6f0c7e1cef0`: 25 commits dated
2026-09-04 through 2026-09-09. Its root, `b99085260291b1eb8301eb54742c06fe66560d2d`, builds a
separate application. Local main has 446 commits through `1a8b0ac`, starting at
`155c9d67e30d51af938ef370b366b634732fb53d`. There is no common ancestor. This is an independent
history, rather than 25 ordinary updates missed by a pull. The prior history-filter map leaves the
inspected remote commits unchanged.

The remote architecture puts product persistence, installs and jobs in Rust, with authoritative
animation and sprite capture in browser Three.js. It uses a different project/capture format,
Comfy-based model provisioning and an optional MCP service. Local main already has the selected
TypeScript core, canonical glTF importer, CLI-first manifest operations, recoverable asset history,
Node/Dawn rendering, aligned AOV atlases and four pure exporters. Combining the trees would leave
competing implementations of those contracts. Cherry-picking feature commits would also depend on
the alternate root and its schemas.

**We need selected behaviors and regression cases, not the remote ancestry or runtime.** Existing
local coverage is retained. Larger useful features below enter the existing roadmap rather than
becoming conditions for this publishing operation.

## Commit-by-commit disposition

These are source-review findings. Remote claims and its older green CI runs do not qualify the
current renderer, models or installed artifacts.

| Commit    | Remote change                                                | Disposition in this repository                                                                                                                                                |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b990852` | Initial Tauri sprite capture workbench                       | Keep our Tauri shell and canonical CLI/render/export contracts; discard the duplicate root implementation.                                                                    |
| `03b838a` | Docked workbench, preferences and diagnostics                | Retain navigation, visible jobs and diagnostics goals in F5-T1/T3; avoid importing another docking framework.                                                                 |
| `a735aa3` | Private Comfy experiment and contribution standards          | Keep existing frozen sidecar recipes and contributor rules. A mandatory Comfy/CUDA/Python stack would duplicate provisioning.                                                 |
| `109ec26` | Portable projects, managed jobs and runtime catalog          | Existing manifest paths, catalog, receipts and F1 job ownership cover the foundations; retain move/reopen recovery cases. Do not import the alternate project format.         |
| `a715b20` | Humanoid rigging, landmarks and saved poses                  | Retain manual fitting, landmark and pose-review requirements in F3-T1/F5-T2; implement through core and reversible manifests.                                                 |
| `987bd50` | Retargeting and project motion libraries                     | Core already retargets once for preview/bake. Retain expanded mapping and reference-frame comparisons for F3/F5.                                                              |
| `7532ae0` | Playback adjustment and bounded sequence exports             | Existing clips support frames/speed/hold-last. Retain explicit current/selected/all library scopes and bounded export review in F5-T2.                                        |
| `19a8748` | Dense mesh preparation and optional background/contact tools | Retain source-versus-working-mesh quality/budget comparison in F3-T1. Optional models still need separate terms, setup and hardware qualification.                            |
| `d9ee959` | Versioned looks and alpha-correct capture                    | Existing core looks and alpha-weighted downsampling cover the main behavior. Keep linear-light/material/light/shadow comparison cases for F6; preserve current goldens.       |
| `c2453ce` | Durable export batches and Godot integration                 | Existing batch planning, BakeManifest and Godot SpriteFrames exporter are authoritative. Retain visible batch recovery UX, rather than another capture schema/player.         |
| `5b3f20b` | Undoable proportion fitting and firm weight regions          | Retain manual fitting/weight ownership and undo acceptance cases in F3-T1/F5-T2; preserve source geometry.                                                                    |
| `1adaa5c` | Headless sprite review runner                                | Keep Node/Dawn proof tools. Do not introduce Chromium and a second Rust capture writer for headless renders.                                                                  |
| `5018963` | Owned background render WebView                              | F1 already owns CLI/worker trees and rejects stale completion. Retain project-switch, cancel and recovery cases without a second renderer.                                    |
| `73f02e4` | Opt-in local MCP review exports                              | Defer: no current requirement justifies another server/SDK. Any future automation remains a projection of existing CLI capabilities.                                          |
| `2901205` | Skinning and deformation review                              | Retain deformation fixtures and review-before-acceptance goals in F3-T1/F5-T2; do not import another browser skinning engine.                                                 |
| `9fdd3ea` | Arm retargeting, vertex selection and skinning detail        | Retain selection/weight editing and rest-frame regression cases. Current core already tests world-space retargeting across different rigs.                                    |
| `e10055c` | Upright references and knee weighting                        | Retain bent/folded-knee and upright reference cases; qualify humanoid heuristics rather than applying them to every rig.                                                      |
| `7af6388` | Balanced limb references and procedural walk                 | Retain proportion and limb-quality comparisons. Keep existing clip packs; a second procedural animator is unnecessary for consolidation.                                      |
| `6d838a7` | Home/navigation and reliable package inventory               | Adapt **Repair runtime** now through existing `models setup`. Retain partial/unreadable/storage reporting and shared-dependency cleanup cases in F3-T2/F5-T1.                 |
| `fac8c9d` | Pixal generation, prepared UV meshes and dense sources       | Current qualified Pixal recipe remains authoritative. Retain dense-source/working-mesh comparison; do not substitute the remote quantized Comfy recipe or camera assumptions. |
| `9389b07` | Reversible alignment and fitting in the corrected frame      | Existing canonical asset history/orientation repair supplies the foundation. Retain tilted/turned bind-frame and source-preservation cases in F3/F5.                          |
| `608e547` | Humanoid frame matching and controlled knee weights          | Retain world-frame/source-knee-pole comparisons in F3-T1. No GUI-owned retargeting path.                                                                                      |
| `e002914` | Managed Make-It-Animatable and source knee guidance          | Retain as an F3-T1 rigging candidate, pending our own exact source/weight/dependency terms, port and measured hardware review. It is not a supported catalog model.           |
| `0918799` | Guided motion review and portable candidates                 | Retain rest/playback restoration, move/reopen and partial-failure recovery cases in F3/F5/F7. Existing immutable candidates and provenance remain the storage model.          |
| `f1f6e39` | Upright alignment and full-library exports                   | Retain asymmetric upright/tilted placement regressions and explicit all-library semantics in F3/F5. These are useful requirements, not evidence they already pass here.       |

## Useful work carried forward

The immediate change exposes the existing runtime repair capability in Studio's model manager.
`models list` includes a version's optional runtime recipe identifier. Installed versions with a
recipe offer **Repair runtime**, show the `models setup` CLI twin, and require explicit license
consent where applicable. Setup retains installed weight files and may download code/dependencies;
Verify remains the separate integrity operation. No new model, runtime, dependency or project schema
is introduced. Focused tests exercise actual CLI consent refusal/success and unchanged install
receipt bytes, and verify that catalog listing exposes repair without provisioning.

The following concrete acceptance cases are retained in
[F3/F5/F6](roadmap.md#later-work--f3-f5-and-f6):

- Compare dense sources with prepared working meshes at sprite size; measure fitting, skinning and
  texture loss before choosing a default budget or auto-rigger.
- Preserve geometry/UVs during placement; an upright asymmetric character with dense clothing must
  stay upright. Test tilted/turned bind frames, folded knees and source-informed bend poles.
- Review candidate idle/walk/action before acceptance. Entering/leaving review must restore the
  exact rest pose or playback time without changing source clips. Moves/reopens and failed later
  candidates must preserve successful earlier candidates.
- Make current/selected/all animation scopes explicit before enqueueing a core batch. “All” must
  include the complete library and chosen directions regardless of search/checkbox filters; changing
  FPS must invalidate incompatible frame-index exclusions and duration overrides.
- Distinguish installed weights, runtime readiness and partial/unreadable inventory. Report storage
  failures honestly and remove shared dependencies only when ownership permits it.
- Compare light/material/shadow behavior and transparent edges using the existing render core, AOV
  contracts and golden discipline.

Useful remote reference files include `crates/generation/src/inventory.rs`,
`src/features/generation/PackageReadiness.tsx`, `src/alignment/placement.test.ts`,
`src/rigging/CandidateMotion.test.ts`, `src/motion/bodyAxes.test.ts` and
`src/batch/animationRequests.ts`. Their cases must be adapted to core contracts, not copied into a
second browser pipeline. Local counterparts include `packages/registry/install.ts`,
`packages/anim/retarget.ts`, `packages/style/downsample.ts` and `apps/studio/parity_test.ts`.

## Recovery and publication

Before changing remote main, all 25 commits were saved in a verified local Git bundle:

```text
.render-bench/remote-main-audit/origin-main-before-consolidation.bundle
SHA-256: 07c6aab96154f4cc0a0d2d11dd9799dd9306235b92bd16668244be0f268af488
Saved ref: refs/remotes/origin/main
```

The bundle and extracted review snapshot are ignored local recovery material, not files delivered by
a fresh clone. Keep a copy outside this checkout if independent long-term recovery is needed. They
preserve the old implementation without adding another active main branch. To inspect it later,
fetch its saved ref into a temporary recovery branch:

```sh
git bundle verify /path/to/origin-main-before-consolidation.bundle
git fetch /path/to/origin-main-before-consolidation.bundle refs/remotes/origin/main:refs/heads/recovered-remote-main
```

Publish the consolidated local main only against the inspected remote SHA, using an explicit
`--force-with-lease=refs/heads/main:<inspected-sha>`. A changed remote must be reviewed before
publication. There is no schema migration between these independent applications in this change; any
existing workspace from the alternate application would need a separately scoped importer. The old
architecture and unselected commits leave the published ancestry, while their complete source
remains recoverable from the bundle.

Review limits: the alternate application was inspected from Git/source, not installed or used to run
models. Its platform, license, performance and deformation claims are not adopted. Hosted CI on the
consolidated head is required next; native hardware/installed-app release qualification remains in
F7 regardless of hosted build results.
