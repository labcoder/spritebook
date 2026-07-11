# SpriteBook — dependencies (bill of materials)

**Rule: check this file before adding any dependency; new deps get a row here in the same PR.**
Status marks: **✓** license verified during the 2026-07 design cycle · **std** well-established, re-confirm at pin time · **⚠** gate open — verify before integration.

**License posture:** everything *bundled* is MIT / Apache-2.0 / BSD / ISC / OFL / CC0. AI model weights are never bundled — catalog entries installed on demand behind license/territory/VRAM gates. No copyleft in the shipped binary path (GPL tooling allowed only as isolated sidecar subprocesses).

## Runtime & shell
| Dependency | Role | License | Status |
|---|---|---|---|
| Deno 2.x | TS runtime, workspace, WebGPU, tests | MIT | std |
| deno desktop **or** Tauri | app shell — **P0-T3 decides (D-005)** | MIT / MIT+Apache-2.0 | std |
| wgpu (under Deno WebGPU) | GPU backend | MIT/Apache-2.0 dual | std |

## Core render, style, pack
| Dependency | Role | License | Status |
|---|---|---|---|
| WGSL shader stack | NPR passes | ours | — |
| fast-png | PNG encode/decode | MIT | std |
| pixelmatch | golden diffs | ISC | std |
| OKLab math | perceptual quantize | ours (tiny) | implement |
| maxrects-packer | atlasing | MIT | std |
| gifenc | contact-sheet artifacts only (player is interactive, never GIF) | MIT | std |
| Mesa lavapipe | CI software Vulkan | MIT | std, CI-only |

## Importer border
| Dependency | Role | License | Status |
|---|---|---|---|
| glTF-Transform | all glTF surgery | MIT | std; pin (byte-determinism) |
| draco3d / meshopt decoders | decode compressed uploads | Apache-2.0 / MIT | std |
| **ufbx** | FBX ingestion | MIT | **✓** — no Autodesk code; Godot 4.3+ default for the same reason. Integration form (wasm vs subprocess): P1-T4 decision, wasm recommended |
| obj2gltf | OBJ ingestion | Apache-2.0 | std |
| mikktspace (wasm) | tangents at render prep | MIT | std |
| @pixiv/three-vrm | VRM conventions reference (VRM 0.x faces −Z) | MIT | std, reference only |

**Rejected: FBX2glTF.** Code BSD-3, but binaries embed the proprietary Autodesk FBX SDK under the Autodesk License and Services Agreement (no redistribution). ✓ verified. Never bundle.

## AI sidecar
| Dependency | Role | License | Status |
|---|---|---|---|
| Python 3.11+ / PyTorch | runtime | PSF / BSD-3 | std |
| rembg | background removal | MIT | std; **⚠ per-weight**: U²-Net Apache-2.0 OK; verify each model file as it becomes a catalog entry |
| Pose check v1 | A-pose advisory | ours (silhouette heuristic on rembg alpha — **no new dep**) | audit item 14 |
| MediaPipe Pose | optional pose-check upgrade | Apache-2.0 | later, catalog-installed extra |

## Generation backends (catalog — installed on demand)
| Backend | License | Status |
|---|---|---|
| Pixal3D | MIT | ✓ · primary; pixel-aligned detail |
| TRELLIS.2 4B | MIT | ✓ · PBR; 16 GB VRAM |
| TripoSplat | MIT | ✓ · gaussians; pairs with MIA |
| Hunyuan3D 2.x | Tencent Community License | ✓ · **excludes EU/UK/KR** — territory gate mandatory |

## Rigging
| Dependency | Role | License | Status |
|---|---|---|---|
| **UniRig** (code + weights) | Track B generic auto-rig | MIT | **✓** both GitHub LICENSE and HF model card; staged checkpoints → registry pins exact hashes |
| Make-It-Animatable | Track A humanoid accelerator (<1 s; meshes & splats; arbitrary pose) | **⚠ unverified** | Confirm repo LICENSE before p3 integration; training pulls Mixamo data. Fallbacks: UniRig humanoid, canonical-body fit |
| Canonical Track A body | roster-fit rig | ours, seeded from CC0 **Universal Base Characters** (Quaternius) | ✓ CC0; also golden-test fixtures |
| Blender/bpy (upstream UniRig tooling) | conversions inside sidecar only | GPL | isolated subprocess; adapters return neutral npz/json; never shipped |

## Animation
| Dependency | Role | License | Status |
|---|---|---|---|
| **Quaternius Universal Animation Library 1+2 — free tiers** | bundled starter pack (~120–130 clips incl. **8-direction locomotion with root motion**) | CC0 | **✓** · one universal humanoid rig = one retarget profile; glTF exports available. Bundle free tiers only; paid Source packs = one-click user import |
| Mesh2Motion assets | alternate + creature clips (Track B future); app = reference implementation | art CC0, code MIT | **✓** explicitly free for personal/commercial |
| Retargeter | humanoid profile retarget, once, in core | ours (TS) | three SkeletonUtils (MIT) as reference only |
| Test-pose pack | rig deform checks | CC0-derived from UAL | bundled asset |

**Traps (do not use):** Mixamo — usable in projects, **not redistributable** (personal user-import only). AMASS / SMPL-family — research-only. Ubisoft LAFAN1 — non-commercial research. Bandai Namco motion datasets — CC-BY-NC. CMU mocap — genuinely free for any use, optional later import path, not the bundled starter.

## GUI
| Dependency | Role | License | Status |
|---|---|---|---|
| React 19 + Vite | framework + build | MIT | std |
| **Base UI** `@base-ui/react` | headless a11y primitives (35 comps incl. number-field scrubbing) | MIT | **✓** v1.0 stable Dec 2025; full-time MUI team incl. Radix authors; WCAG out of the box |
| three.js (pinned) + camera-controls + three-viewport-gizmo + TransformControls | inspection viewports | MIT | std |
| Lingui | ICU i18n | MIT | std |
| zustand | GUI-local state | MIT | std |
| Chakra Petch, IBM Plex Sans/Mono | type | SIL OFL 1.1 | std |
| Lucide | icons | ISC | std |

## Open gates
1. Make-It-Animatable license — before p3-T4.
2. rembg per-weight licenses — as catalog entries land.
3. deno desktop vs Tauri — P0-T3 (D-005).
