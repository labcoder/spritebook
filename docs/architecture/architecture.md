# SpriteBook — architecture

## System overview

Three processes, one contract:

- **Core (TypeScript on Deno).** The product. Owns manifests, the job queue, the importer border,
  the WebGPU render/style/pack/export pipeline, animation retargeting, caching, and the CLI.
  Headless by design — Deno's WebGPU has no swapchain, which is exactly right for a batch renderer.
  _Confirmed by the P0-T2 spike (D-004 ratified): ~190 f/s render+readback at 128 px on the dev GPU,
  cross-process byte-deterministic; `spikes/webgpu/` doubles as the canary to re-run before any Deno
  upgrade._
- **AI sidecar (Python).** Torch-based adapters for catalog models: background removal, image→3D
  backends, auto-rigging. Talks to core over a local contract (below). Installed per machine; never
  bundled.
- **GUI shell (Tauri v2 — D-005 ratified, resolved by P0-T3).** React 19 + Vite + Base UI +
  hand-authored tokens, with Deno as the sole JS toolchain (no Node). A projection of core: it
  invokes CLI verbs, renders the NDJSON stream, and displays core-produced pixels. Three.js
  viewports are inspection instruments only — and must be able to degrade to core-rendered PNG
  sequences (Linux WebKitGTK caveat, see `spikes/shell/REPORT.md`). Production bridge rule from the
  spike: per-job IPC channels, never global event names. A `deno desktop` revisit trigger is
  recorded in D-005.

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
4. **glTF at the border (D-012).** All ingestion (glb/gltf/obj/fbx-via-ufbx/vrm) normalizes to
   canonical, uncompressed glTF with enforced conventions: +Y up, meters, faces +Z (VRM 0.x rotated
   on import), feet at Y=0, uniform scale. Emits a persisted `PreflightReport`. Double-import of the
   same source must produce identical bytes (CI-enforced).
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

## Module map (materialized as the `packages/*` Deno workspace at P1-T1; `gui` arrives p4, `sidecar` p3)

| Package            | Owns                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `schema`           | All types in `data-models.ts`, validation, `ManifestPatch`, migrations                    |
| `core`             | Queue, events, journal/undo, cache, orchestration                                         |
| `importer`         | Border: readers (glTF-Transform, ufbx-wasm, obj2gltf), canonicalization, PreflightReport  |
| `render`           | Headless WebGPU: MRT AOVs, skinning, readback                                             |
| `style`            | NPR stack: quantize (OKLab), dither, outlines, temporal toolkit, flicker metric           |
| `anim`             | Pack ingestion, humanoid retarget profile, clip sampling, preview clip emission           |
| `pack`             | MaxRects atlasing, parallel-layout guarantee, contact sheets                              |
| `gen`              | Generation pipeline: registry → sidecar → **the border** → GenerationResult; reprojection |
| `export`           | Godot / Aseprite / TexturePacker / strips — projections of BakeManifest                   |
| `registry`         | Catalog/installed/pins, gates, verify                                                     |
| `cli`              | Verb surface (`gen, pick, rig, anim, look, bake, export, models, clone, rename, undo…`)   |
| `gui`              | Shell app; framework-agnostic viewport classes                                            |
| `sidecar` (Python) | Adapters: rembg, gen backends, rig backends                                               |

## Non-goals of the architecture

No cloud services in the core path; no telemetry; no plugin system in 1.0 (exporters are in-tree
projections); no cross-machine render determinism assumptions, ever.

## F1 persistence and execution policy

The [workspace persistence protocol](workspace-persistence.md) defines the recoverable writer,
canonical asset revisions, job ownership and consistent read projections. The
[execution policy](execution-policy.md) defines project pins, receipt verification, declared consent
and configuration-specific VRAM admission. These protocols preserve the laws above while the runtime
is still Deno; replacing that runtime is F2/F4 work.
