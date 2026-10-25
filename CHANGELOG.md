# Changelog

Notable changes to SpriteBook. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version, tag, and golden policy is in
`docs/developer/versioning.md` in the repository.

## Unreleased

## 0.7.0 - 2026-10-24 · Imprint desktop update

- Adopt the off-white Imprint app icon, with a blue folded corner and peeking mouse, in the Windows
  application and installer.
- Add **File → About SpriteBook** with the app version and project link. The editor layout is
  unchanged.
- Show CLI usage with no arguments, `--help`, `-h` or `help <command>`. Command help includes
  descriptions, accepted options and examples, including model runtime repair. Help exits before
  project writes or model work and supports a single JSON document with `--json`.
- Expand the user CLI guide with command discovery, quoting, output formats and exit codes.

The Windows preview's existing animation/clothing limitations still apply; see 0.6.0 below.

## 0.6.0 - 2026-10-24 · Windows workbench preview

Automatic binding and clothing motion still need review. This preview improves the workflow and
capture/export reliability; it does not certify generated rigs or collision-free animation.

- Delete a character project from its context menu, Edit menu or command palette, with explicit
  confirmation. Generated assets are removed; original inputs and unrelated user files remain.
- Export validates atlas paths, stages delivery and restores the previous files after a failed or
  cancelled publication. A later export recovers interrupted publication before writing again.
- Keep decoded atlas memory bounded during strip export. Release GPU resources after failed jobs,
  partial setup and early event-consumer closure.
- Reject unsafe model-removal paths and prototype traversal in saved journal patches. Bound native
  preview/log reads and release file-drop subscriptions when their form closes.
- Retry brief Windows VRAM mutex permission failures without bypassing the memory budget. Failed
  acquisitions now remove their claim and stop its heartbeat; persistent permission errors refuse.
- Reorganize public documentation into user and developer guides, with a real workbench screenshot.
  Patch Vite, Zod and URI parsing dependencies to resolve reported advisories.

- Manage extensions groups models, optional tools and bundled content. Blender can use a checked
  existing installation or an explicit portable download, with progress and ownership-aware removal.
- Start from a mesh or the bundled CC0 reference character. Existing skin weights are preserved;
  imports record source provenance and support undo/redo. Skinned height and grounding now affect
  the rendered surface as well as its bounds. Integer skin weights decode correctly; invalid weights
  and unsupported extra influences refuse before publishing an altered rig.
- Review walking, takeoff, airborne jump and landing before accepting a rig or generated candidate.
  Candidate auditions use a separate draft workspace and keep the selected character intact. Sampled
  surface checks assist visual review; they do not certify clothing or anatomical binding. Already
  upright candidates can explicitly skip automatic straightening in a separate draft. Missing review
  images or previews can be rebuilt without repeating inference.
- Keep complete clip/direction sequences together on atlas pages when they fit. Export checks
  unsupported page/target combinations before writing selected targets.
- Candidate thumbnails frame the complete mesh, including broad outstretched arms. Uncertain rig
  labels no longer promise that contradictory joint chains can animate.
- Retry an interrupted initial import or optional-tool install without replacing accepted assets or
  deleting unrelated programs. Blender remains optional; experimental garment and ownership
  corrections are not applied automatically.

## 0.5.0 - 2026-10-23 · Windows capture/export preview

This unsigned preview focuses on camera composition, rendering and exporting sprites/model assets.
Earlier prototype entries keep their original version numbers. The maintainer approved publication
with the motion limitations below; this is not a production-quality auto-rigging release.

**Known motion limitations:** generated characters can have incorrect skin ownership where hands
touch clothing, stretched hands/shoulders and legs intersecting loose skirts during walk/jump.
Review animation before baking. Accepting a rig records your review; it does not repair these
problems. Use an authored, well-rigged mesh for the most reliable capture/export evaluation.

- Tauri and TypeScript remain the desktop and core; the application owns its Node runtime.
- Look composes camera projection, angles, lighting and output size against a fresh core-rendered
  frame. Original preserves full color; pixel, cel and painterly finishes remain available.
- Output cells support 64 through 4096 pixels, with GPU-size preflight and multipage atlas playback.
- Export can copy the canonical GLB and embedded textures independently of sprite baking.
- Windows walk/jump exports pass atlas, timing, strip-pixel and Godot resource checks. Amy's skin
  ownership and Bulma's skirt motion remain open quality work; experimental repairs do not ship.
  Godot/Unity engine import, native Mac/Linux/ARM desktop use and signed distribution are
  unqualified.
- Model compatibility detection no longer assumes every Mac supports model acceleration; unknown
  operating systems cannot inherit Linux recipes and driver probes have a bounded timeout.

## 0.9.0 - 2026-08-06

The GUI release. SpriteBook Studio wraps the proven CLI in six guided stages, and the pipeline grew
the batch verbs, the memory discipline, and the documentation a 1.0 needs. Not 1.0: the maintainer's
own UX pass comes first, and the gen3d licensing finding below is unresolved.

### Added

- **SpriteBook Studio**, the desktop app (Tauri 2 + React 19 + Base UI). Six stage surfaces —
  Generate, Rig, Animate, Look, Bake, Export — over a gallery and character tabs. Every screen is a
  projection of the manifest, and every primary action shows the CLI line it runs.
- **Stage 01 Generate**: backend cards from the real catalog with their license, VRAM and install
  gates in context; the options form derived from each backend's own `paramsSchema`; candidates,
  More-like-this, and the canonical-mesh checkpoint.
- **Stage 02 Rig**: both tracks, the deform report verbatim, orientation fixes as one-click re-runs,
  and acceptance as an explicit journaled act.
- **Stage 03 Animate**: the 86-clip library with search and categories; bindings as journaled
  decisions through the new `anim --enable` / `anim --disable` verbs.
- **Stage 04 Look**: camera and style controls, pixel-truth direction strips sliced from the last
  bake's own atlas at integer zoom, and the stale-frame count stated before you record.
- **Stage 05 Bake**: segmented progress, a sprite player with direction and AOV toggles, and QA
  flags that jump to the stage that owns the fix.
- **Stage 06 Export**: every target over one bake manifest.
- **3D viewports**: mesh inspection in Generate, and a bone overlay in Rig with joint picking and
  gizmo nudge.
- **Batch verbs**: `bake --all` and `bake --changed-since` over a roster manifest, with `--plan`
  showing what is stale and why before anything runs.
- **Cross-process VRAM lease**: concurrent jobs on one machine queue instead of competing, and the
  job's own event stream says why a job is waiting.
- **Command palette** (Ctrl+K), **Manage models** (Ctrl+M), undo and redo over the journal, a log
  drawer that renders the CLI stream verbatim, dark and light themes, and English and Spanish.
- **Documentation**: a Studio user guide, four engine import guides (Godot, Unity through
  TexturePacker, Phaser, Aseprite), and a licensing explainer. All written to ASD-STE100 Simplified
  Technical English.

### Changed

- **The default cell is 112 px with 16 px of padding**, up from 96 and 6 (D-032, D-035). The old
  default was sized for an idle pose; a six-clip set reaches sideways and a lying-down death reaches
  metres toward the camera. Measured over 368 frames, the new default takes clipped frames from 63
  to zero. It costs 0.02 MB per character on disk and 34% of wall clock.
- **Rig acceptance is out of the cache key** (D-031). Recording that you looked at a deform report
  now re-bakes nothing.
- Every existing bake re-keys once against the new camera preset, and appears as stale with
  `cameraPresetHash` as the reason. Exported pivot numbers move; the pivot's MEANING does not.

### Fixed

- **Keyboard focus survives every operation.** Async buttons no longer disable themselves while
  focused, so a keyboard user is not dropped to the top of the document after each run; focus lands
  on the result content when success swaps a panel; and the radio groups implement the arrow-key
  contract their role announces.
- Locked pipeline stages are reachable, so the reason they are locked can be read.
- The log drawer closes with Escape and returns focus to its handle.

### Known limitations

- **The TRELLIS.2 gen3d backend cannot be used for commercial work today.** Its weights are MIT, but
  three of the five CUDA extension wheels its adapter needs are non-commercial (`nvdiffrast`,
  `nvdiffrec_render`) or carry no license at all (`o_voxel`). SpriteBook does not bundle them — your
  machine fetches them at install time — and the D-036 survey found no alternative backend that
  passes all four ship gates. See `docs/licensing.md`. The `fixture-gen` backend and every other
  stage are unaffected.
- **AI generation and rigging need an NVIDIA GPU.** There is no CUDA on Windows on ARM, and none on
  macOS. Those platforms run the whole app and the whole pipeline with the weightless `fixture-gen`
  backend; they cannot run the downloaded models.
- Joint nudge in the rig viewport needs a pointer. The keyboard path to joint edits is the
  edits-file verbs, which is an alternative rather than an equivalent.

## 0.1.0-alpha.1 - 2026-07-18

First alpha: the headless bake pipeline, end to end. A rigged 3D character goes in; deterministic,
engine-ready 2D spritesheets come out. One CLI binary, no GUI yet.

### Added

- **CLI** (`spritebook`): verbs `bake`, `export`, `doctor`, `undo`, `redo`, plus `--version`. Jobs
  stream human-readable progress by default and NDJSON job events with `--json` (`doctor --json`
  emits a single JSON document instead — a diagnostic snapshot, not a job stream).
- **Bake pipeline** (`spritebook bake`): renders a rigged `.glb` through the headless WebGPU
  renderer, styles it, packs it, and writes a self-contained bake dir — `manifest.json` (the
  canonical BakeManifest with full provenance), `atlas_<pass>_<i>.png` pages, `style-result.json`,
  and a review-only `contact-idle.gif` contact sheet.
- **5-AOV renderer**: one MRT pass per frame producing lit, albedo, normal, depth, and mask;
  world-locked orthographic framing (the pivot lands on the same pixel in every direction); 2, 4, 8,
  or 16 directions; deterministic idle and turntable poses.
- **Temporally-stable NPR styling**: OKLab adaptive palettes, ordered dithering, depth/normal
  outlines, and alpha bleed — supersampled, then downsampled with texel snapping, cluster voting,
  and palette hysteresis so animations do not shimmer. Every bake records a flicker metric
  (`flickerPct`) and warns when a style exceeds its budget.
- **Three style presets**: `cel-2`, `pixel-8`, `painterly`.
- **Deterministic packing**: MaxRects atlas layout pinned to a deterministic subset (D-022). One
  layout is computed from the lit cells and replayed verbatim on every AOV page, so AOV pages are
  rect-identical to the lit page by construction.
- **Four export targets** (`spritebook export`), all pure projections of the BakeManifest: `godot`
  (SpriteFrames `.tres` + atlas pages, one animation per direction), `aseprite` ("JSON (array)"
  `.ase.json` + pages), `texturepacker` ("JSON Hash" `.tp.json` + pages — the flavor Phaser 3 and
  Unity consume), and `strips` (per-direction horizontal strip PNGs + a JSON index). Exporting an
  unchanged bake is byte-identical; volatile manifest fields are never projected.
- **Input-hash frame cache** (`--cache`, `--only-invalidated`): keys hash the full recipe — model
  bytes, camera, style, clip, and the D-023 render signature (`<renderer version>#<adapter hash>`) —
  so an adapter change is an honest full cache miss (driver-version-only updates are a documented
  gap — see docs/developer/versioning.md).
- **Journaled undo/redo** (`spritebook undo` / `spritebook redo`): manifest edits are append-only,
  reversible patches with a cursor. Undo/redo is core behavior, not a GUI trick.
- **`spritebook doctor`**: product and render-pipeline versions, backend env, adapter identity, the
  render signature, the GPU limits the renderer depends on, and a clear-pass render probe. Exits 0
  only when an adapter exists and the probe passes.
- **Importer border** (from source, not in the alpha binary): glTF/GLB, OBJ, FBX (via the three.js
  FBXLoader bridge, D-020), and VRM canonicalize to deterministic glTF with a preflight report
  (D-012).

### Fixed

- Palette hysteresis compared squared OKLab distances against a squared epsilon, making the
  temporal-stability band several-fold too narrow; distances and epsilon are now linear (D-021).
- A volatile temp-dir path leaked into persisted bake artifacts and broke byte-stability of
  warm-cache bakes; caught by the double-bake acceptance test.
- Adversarial-review passes over the style stack and the packer/exporters hardened the seams: strict
  `.tres` parsing cross-checked against the manifest, argument errors surfaced as NDJSON error
  events instead of raw throws, prototype-safe style lookup, corrupt cache values self-healing as
  misses.

### Infrastructure

- Deno workspace (ten packages) with agreement enforcement in CI: conventional-commit lint,
  tests-required-per-change, and a bundled-dependency license guard.
- CI matrix on Linux/macOS/Windows plus a Mesa lavapipe (software Vulkan) lane that runs the render,
  style, pack, and export suites against a real adapter and uploads a render-throughput report per
  run.
- Perceptual golden suite for the style presets — portable, because the style stage is deterministic
  CPU over committed AOV fixtures — plus an exact placement golden tripwiring the packer.

### Licensing

- AGPL-3.0-only with an output exception (D-019): spritesheets, atlases, manifests, and other assets
  you bake are yours — not subject to the AGPL — usable in personal, commercial, open-source, or
  proprietary projects. See `NOTICE`.

### Known alpha limitations

- One built-in `idle` pose. The clip system (animation packs, retargeting, per-clip bakes) lands
  with the animation package.
- The three style presets are fixtures: preset modes are realized as quantization variants;
  ramp-based cel shading is a future render-side mode.
- The importer is not wired into the packaged binary. The alpha binary bakes rigged `.glb` files (a
  sample ships in the release zip); importing FBX/OBJ/VRM means running from source.
- Real-engine export validation (Godot/Phaser/Aseprite imports) is deferred to the end of the
  project by design; exports are validated structurally and for byte-stability on every CI run
  (`docs/developer/export-validation.md` in the repository).
