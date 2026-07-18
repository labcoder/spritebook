# Changelog

Notable changes to SpriteBook. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version, tag, and golden policy is in
`docs/versioning.md` in the repository.

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
  gap — see docs/versioning.md).
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
  (`docs/export-validation.md` in the repository).
