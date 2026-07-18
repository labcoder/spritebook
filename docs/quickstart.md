# Quickstart

<!-- SKELETON (P2-T4): every TRANSCRIPT/METRIC comment below is a placeholder the release
integrator replaces with real output captured from the release binary. Do not hand-write
transcripts. -->

Bake a rigged 3D character into engine-ready 2D spritesheets, locally, in five minutes.

## 1. Download

Grab the zip for your platform from the GitHub release: `win-x64`, `mac-arm64`, `mac-x64`, or
`linux-x64`. On Windows-on-ARM use `win-x64` — it runs under x64 emulation (see
`docs/platform-support.md` in the repo).

Unzip it anywhere. Contents:

```
spritebook (.exe on Windows)   the CLI binary
sample/asymmetric.glb          a small rigged test character (deliberately one-armed)
quickstart.md                  this file
```

## 2. First run on each OS

Alpha binaries are unsigned (signing arrives with the 1.0 desktop bundle — `docs/versioning.md`), so
each OS objects exactly once:

- **Windows**: SmartScreen may block the first run — click **More info -> Run anyway**.
- **macOS**: if Gatekeeper blocks it, allow it under **System Settings -> Privacy & Security ->
  "Open Anyway"**, or clear the quarantine attribute: `xattr -d com.apple.quarantine ./spritebook`
- **Linux**: mark it executable: `chmod +x ./spritebook`

## 3. Check your GPU

Baking renders on your GPU through WebGPU. Verify the machine first:

```
spritebook doctor
```

Healthy output shows the product and render-pipeline versions, your adapter, the render signature
(the renderer + adapter identity that cache keys carry), and a passing render probe
(`render probe: OK`):

<!-- TRANSCRIPT:doctor -->

`doctor` exits 0 only when an adapter exists **and** the probe passes. If it prints `adapter: NONE`,
see Troubleshooting below.

## 4. Bake

```
spritebook bake --model sample/asymmetric.glb --character hero --out bakes --style pixel-8 --directions 8 --frames 6
```

<!-- TRANSCRIPT:bake -->

The bake lands in a content-addressed directory, `bakes/bake-<id>/`:

| File                                                                             | What it is                                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                                                                  | the canonical BakeManifest: every frame's atlas rect and pivot, provenance (inputs, render signature), metrics |
| `atlas_lit_0.png`                                                                | the styled spritesheet page(s) — what your game draws                                                          |
| `atlas_albedo_0.png` `atlas_normal_0.png` `atlas_depth_0.png` `atlas_mask_0.png` | AOV pages, rect-identical to the lit page — for dynamic lighting, outlines, custom shaders                     |
| `style-result.json`                                                              | the style stage's artifact: palette, flicker metric, warnings                                                  |
| `contact-idle.gif`                                                               | animated contact sheet for eyeballing the bake — review-only, not a game asset                                 |

## 5. Export

```
spritebook export --bake bakes/bake-<id> --out exports --targets godot,aseprite,texturepacker,strips
```

(`bakes/bake-<id>` is the bake directory printed by step 4.)

<!-- TRANSCRIPT:export -->

One subdirectory per target:

| Target           | Files                                                          | Point your engine at it                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `godot/`         | `hero.tres` + `atlas_lit_*.png`                                | copy both into a Godot 4 project; assign `hero.tres` as the SpriteFrames of an `AnimatedSprite2D`; animations are named `idle_d00` ... `idle_d07`                                 |
| `aseprite/`      | `hero.ase.json` + `atlas_lit_*.png`                            | Aseprite: **File -> Import Sprite Sheet** honors the JSON                                                                                                                         |
| `texturepacker/` | `hero.tp.json` + `atlas_lit_*.png`                             | Phaser 3: `this.load.atlas('hero', 'atlas_lit_0.png', 'hero.tp.json')`; frame names are `idle_d00_f000` etc.; set `frameRate` at anim creation (this format carries no durations) |
| `strips/`        | `hero-idle-d<DD>-strip.png` per direction + `hero-strips.json` | hand-rolled loaders; the JSON carries cell size, fps, and per-direction pivots                                                                                                    |

Multi-page bakes suffix the Aseprite/TexturePacker JSON per page (`hero_p1.ase.json`); animations
never span pages.

## Styles

| Style       | Look                           | Palette                  | Dither      | Outline | Alpha |
| ----------- | ------------------------------ | ------------------------ | ----------- | ------- | ----- |
| `cel-2`     | flat cel tones                 | adaptive, max 6 (OKLab)  | none        | 1 px    | 1-bit |
| `pixel-8`   | classic pixel art              | adaptive, max 8 (OKLab)  | 4x4 ordered | 1 px    | 1-bit |
| `painterly` | soft edges, larger tonal range | adaptive, max 32 (OKLab) | none        | none    | soft  |

All three render supersampled and downsample with temporal stabilization (texel snapping, palette
hysteresis), so frames do not shimmer in motion.

## Flag reference

### `spritebook bake`

| Flag                 | Default    | Meaning                                                         |
| -------------------- | ---------- | --------------------------------------------------------------- |
| `--model <path>`     | (required) | rigged `.glb` to bake                                           |
| `--character <id>`   | (required) | immutable character slug; binds cache keys                      |
| `--out <dir>`        | (required) | bakes land at `<dir>/bake-<id>`                                 |
| `--style <id>`       | `pixel-8`  | `cel-2`, `pixel-8`, or `painterly`                              |
| `--directions <n>`   | `8`        | `2`, `4`, `8`, or `16`                                          |
| `--frames <n>`       | `6`        | frames of the built-in idle pose (positive integer)             |
| `--cell <px>`        | `64`       | square output cell size                                         |
| `--ppm <n>`          | `32`       | pixels per meter (world scale)                                  |
| `--elevation <deg>`  | `30`       | camera elevation angle                                          |
| `--padding <px>`     | `6`        | transparent padding inside each cell                            |
| `--cache <dir>`      | (off)      | input-hash frame cache; the bake always writes through when set |
| `--only-invalidated` | (off)      | serve unchanged frames from the cache (all-or-none per bake)    |
| `--json`             | (off)      | NDJSON job events on stdout                                     |

### `spritebook export`

| Flag                  | Default    | Meaning                                                         |
| --------------------- | ---------- | --------------------------------------------------------------- |
| `--bake <dir>`        | (required) | a bake directory produced by `spritebook bake`                  |
| `--out <dir>`         | (required) | export root; one subdirectory per target                        |
| `--targets <a,b,...>` | (required) | comma-separated: `godot`, `aseprite`, `texturepacker`, `strips` |
| `--fps <n>`           | `8`        | playback rate projected into duration-carrying formats          |
| `--json`              | (off)      | NDJSON job events on stdout                                     |

### `spritebook doctor`

| Flag     | Default | Meaning                                                    |
| -------- | ------- | ---------------------------------------------------------- |
| `--json` | (off)   | one JSON document (a snapshot, not an NDJSON event stream) |

## Troubleshooting

- **`adapter: NONE - GPU rendering unavailable`** — `doctor` prints hints with it:
  - check that your GPU drivers are installed and current;
  - force a backend: `DENO_WEBGPU_BACKEND=vulkan` (Windows/Linux), `dx12` (Windows), or `metal`
    (macOS);
  - headless Linux / CI: install Mesa lavapipe (`mesa-vulkan-drivers`) for a software adapter.
- **`render probe: FAILED`** — an adapter exists but a minimal render pass failed; the error text is
  in the output. Update drivers or try the other backend for your OS.
- **`SPRITEBOOK_REQUIRE_GPU=1`** turns a missing adapter into a hard error instead of a skip (useful
  in CI so a broken lane cannot pass as "skipped, green").
- **Same model, different machine, different pixels** — expected. Pixels are deterministic per
  (pipeline version, adapter, driver); a GPU or driver change deliberately misses the whole cache.
  `doctor` prints the render signature that identifies your combination.

## Performance

Reference numbers for the step-4 bake (8 directions x 6 frames, 64 px cells, `pixel-8`):

- Dev GPU: <!-- METRIC:dev -->
- CI software rasterizer (Mesa lavapipe): <!-- METRIC:ci -->
