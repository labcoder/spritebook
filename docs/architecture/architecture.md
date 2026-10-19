# SpriteBook — architecture

## System overview

Three processes, one contract:

- **Core (TypeScript on Node 24 LTS).** Owns manifests, jobs, the importer border, animation
  retargeting, rendering/style/pack/export, caching and CLI composition. JavaScript is emitted by
  TypeScript project references; normal package exports resolve the emitted modules. Headless WebGPU
  uses pinned Dawn (`webgpu` 0.6.2), with explicit device/root disposal. F4's paired Windows
  workload matches the legacy control's pixels; old PNG bytes and renderer cache identities differ.
- **AI sidecar (Python).** Torch-based adapters for catalog models: background removal, image→3D
  backends, auto-rigging. Talks to core over a local contract (below). Installed per machine; never
  bundled.
- **GUI shell (Tauri v2 — D-005 ratified, resolved by P0-T3).** React 19 + Vite + Base UI +
  hand-authored tokens, built by Vite in the same locked npm workspace. A projection of core: it
  invokes CLI verbs, renders the NDJSON stream, and displays core-produced pixels. Three.js
  viewports are inspection instruments only — and must be able to degrade to core-rendered PNG
  sequences (Linux WebKitGTK caveat, see `spikes/shell/REPORT.md`). Production bridge rule from the
  spike: per-job IPC channels, never global event names. Tauri remains the selected shell (D-041);
  no alternative GUI port is scheduled.

```mermaid
flowchart TB
  subgraph GUI [GUI shell — projection]
    UI[React + Base UI] --> VP[three.js inspection viewports]
  end
  subgraph CORE [spritebook core — Deno/TS]
    CLI[CLI verbs] --> Q[Job queue + NDJSON events]
    Q --> IMP[Importer border → canonical glTF]
    Q --> ANIM[Retarget + clip sampling]
    Q --> REN[WebGPU render: MRT AOVs]
    REN --> NPR[NPR style stack]
    NPR --> PACK[Atlas packer]
    PACK --> EXP[Exporters ← BakeManifest]
    Q --> CACHE[(Input-hash cache)]
    Q --> REG[(Registry: catalog / installed / pins)]
  end
  subgraph SIDECAR [Python sidecar]
    REM[rembg] & GEN[image→3D adapters] & RIG[auto-rig adapters]
  end
  UI -->|CLI twins| CLI
  UI <-->|NDJSON| Q
  Q <-->|localhost HTTP + NDJSON + token| SIDECAR
```

## The laws

1. **Manifest as the only interface (D-002/D-003).** Every capability is a CLI verb over manifest
   files. GUI features that lack a verb are architecture bugs.
2. **Preview/export parity (D-006), extended: retarget-once.** One render core serves previews and
   bakes. Animation preview clips are retargeted _by core_ and streamed to the GUI; the GUI never
   runs its own retarget — two implementations would eventually disagree, and the user would tune
   against a lie.
3. **Cache = f(inputs) (D-011).** Keys hash canonical inputs — mesh hash, rig state, clip binding,
   camera preset, style preset, `rendererVersion`, backend@version+params — and bind to the
   immutable `characterId`. Output pixels are never hashed (GPUs are not cross-machine
   deterministic). Renaming a character invalidates nothing.
4. **glTF at the border (D-012).** All ingestion (glb/gltf/obj/fbx/vrm) normalizes to canonical,
   uncompressed glTF with enforced conventions: +Y up, meters, faces +Z (VRM 0.x rotated on import),
   feet at Y=0, uniform scale. Emits a persisted `PreflightReport`. Double-import of the same source
   must produce identical bytes (CI-enforced).
5. **Registry is data (D-009).** Three layers, npm-style: `catalog` (models.json: entries, versions,
   licenses, territories, VRAM/disk, `paramsSchema`) → `installed` (per-machine state under the
   platform local-data directory, or `SPRITEBOOK_MODELS_DIR`, verified hashes) → `pins` (per-project
   exact versions). Backends and **animation packs** are both catalog citizens. Gates (license
   acceptance, territory, VRAM preflight) run before install and before jobs.
6. **BakeManifest is canonical (D-010).** Frames, atlas pages, pivots, metrics, flags. Exporters are
   pure projections; AOV pages (normal/mask/depth) are rect-identical to the lit page — engines can
   swap textures under one layout.
7. **Undo is core.** Every mutation is a `ManifestPatch {op, inverse}` appended to a journal;
   `spritebook undo` and the GUI stack replay it. No GUI-only state worth keeping exists.
8. **Determinism.** Fixed, recorded seeds; deterministic quantization; same machine → same bytes
   (double-render canary in CI). Anything stochastic takes its seed from the manifest.

## Event & diagnostics contract

Jobs emit NDJSON: `queued | started | progress | artifact | warn | error | done`, each with jobId,
timestamps, and `retryable` on errors. Core keeps a session ring buffer plus an optional file sink;
the GUI's log drawer renders the stream **verbatim** — what CI sees is what users see. Errors badge
the collapsed status bar.

## Sidecar contract (specified; implemented p3-T2)

Localhost HTTP; per-session auth token minted by core; version handshake on connect; job endpoints
stream NDJSON back. Adapters declare `paramsSchema` (JSON Schema) that both validates
`GenerationResult.params` and drives GUI option forms. Rig adapters accept optional **joint
placement hints** (the re-run-with-markers escape hatch). GPL tooling (e.g. Blender/bpy used by
upstream UniRig scripts) stays inside the sidecar process boundary; adapters return neutral data
(skeleton/weights as npz/json) that core applies to glTF itself.

## Rigging tracks

- **Track A (humanoid roster fit):** a canonical rigged body (seeded from CC0 Universal Base
  Characters) fitted to generated meshes; identity carried by textures, detail-layer decals,
  attachments, and bone masks; shared UVs enable palette ops at roster scale. Mirroring **opt-in per
  character** (D-008) — asymmetric identity is first-class.
- **Track B (generic):** UniRig (MIT, code+weights) for arbitrary topologies. Candidate accelerator
  for A: Make-It-Animatable (<1 s humanoid rig, meshes _and_ splats, arbitrary input pose) —
  **license gate open; verify before integration.**
- Repair verbs are core capabilities (p3): `rig --edits <patch>`, `--face-front`, `--feet-ground`,
  `--center`, `--rerun-with-hints`. The GUI's two-tier repair UI wraps them.

## Module map (npm workspaces under `packages/*` and `apps/studio`)

| Package            | Owns                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `schema`           | All types in `data-models.ts`, validation, `ManifestPatch`, migrations                          |
| `core`             | Queue, events, journal/undo, cache, orchestration                                               |
| `importer`         | Border: readers (glTF-Transform, three-FBX bridge, obj2gltf), canonicalization, PreflightReport |
| `image`            | Shared PNG codec and PNG/JPEG ndarray boundary; avoids Sharp/libvips in the runtime             |
| `render`           | Headless WebGPU: MRT AOVs, skinning, readback                                                   |
| `style`            | NPR stack: quantize (OKLab), dither, outlines, temporal toolkit, flicker metric                 |
| `anim`             | Pack ingestion, humanoid retarget profile, clip sampling, preview clip emission                 |
| `pack`             | MaxRects atlasing, parallel-layout guarantee, contact sheets                                    |
| `gen`              | Generation pipeline: registry → sidecar → **the border** → GenerationResult; reprojection       |
| `export`           | Godot / Aseprite / TexturePacker / strips — projections of BakeManifest                         |
| `registry`         | Catalog/installed/pins, gates, verify                                                           |
| `cli`              | Verb surface (`gen, pick, rig, anim, look, bake, export, models, clone, rename, undo…`)         |
| `gui`              | Shell app; framework-agnostic viewport classes                                                  |
| `sidecar` (Python) | Adapters: rembg, gen backends, rig backends                                                     |

## Non-goals of the architecture

No cloud services in the core path; no telemetry; no plugin system in 1.0 (exporters are in-tree
projections); no cross-machine render determinism assumptions, ever.

## F1 persistence and execution policy

The [workspace persistence protocol](workspace-persistence.md) defines the recoverable writer,
canonical asset revisions, job ownership and consistent read projections. The
[execution policy](execution-policy.md) defines project pins, receipt verification, declared consent
and configuration-specific VRAM admission. These protocols preserve the laws above on Node. The
[Windows renderer proof](../../future/renderer-qualification.md) and
[F4 cutover evidence](../../future/runtime-cutover.md) record the runtime transition and remaining
release gates.

## Installed ownership

Tauri launches app-owned Node and `runtime/core/cli.mjs` through the shared native process owner.
The portable `spritebook` launcher owns the same worker tree. Native code handles process groups/
Windows Job Objects and kernel file locks; TypeScript owns all product policy. Startup gates prevent
workers escaping before assignment. Cancellation keeps each job's stdout/stderr channels separate.

`SPRITEBOOK_RESOURCES` identifies immutable catalogs, shaders, clips, bodies and Python source.
Source development resolves equivalent assets from compiled packages. `ubc-male` is the portable
bundled body ID; explicit body paths remain supported. The installer includes the locked production
package tree so importer CJS loaders and decoders retain their relative assets. It contains no
source TypeScript, development node_modules, compiler, model weights or copied virtual environment.

Owned uv uses frozen resolution. Installed Python environments live in writable platform application
data, keyed by the sidecar lock; `UV_PROJECT_ENVIRONMENT` remains an explicit override. Runtime
builds stage and seal the complete payload before publishing, and recover a previous generated
payload if interrupted between directory renames. This builder guarantee is separate from F7's
clean-machine installer upgrade/uninstall qualification.
