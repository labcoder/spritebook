# Quickstart

<!-- Transcripts below were captured from the real compiled win-x64 binary (lean release build,
2026-07-18) running in a fresh directory laid out like the release zip. Regenerate them the same
way when behavior changes; never hand-write them. -->

Bake a rigged 3D character into engine-ready 2D spritesheets, locally, in five minutes.

Starting from an IMAGE instead of a rigged model? That path is `gen`, `pick`,
and `rig`, and it needs an installed AI backend. `docs/cli.md` walks it
command by command; the guide covers the same flow in Studio. This file's
five minutes start where a rigged `.glb` already exists.

## 1. Download

Grab the zip for your platform from the GitHub release: `win-x64`, `mac-arm64`, `mac-x64`, or
`linux-x64`. On Windows-on-ARM use `win-x64` — it runs under x64 emulation (see
`docs/platform-support.md` in the repo).

Unzip it anywhere. Contents:

```
spritebook (.exe on Windows)   the CLI binary
sample/asymmetric.glb          a small rigged test character (deliberately one-armed)
quickstart.md                  this file
CHANGELOG.md                   what is in this release
```

The alpha zips carry the CLI only. SpriteBook Studio, the desktop app the
guide describes, ships with the 1.0 bundle. Until then, every Studio action
has a CLI twin, and this file plus `docs/cli.md` cover them all.

## 2. First run on each OS

Alpha binaries are unsigned (signing arrives with the 1.0 desktop bundle — `docs/versioning.md`), so
each OS objects exactly once:

- **Windows**: SmartScreen may block the first run — click **More info -> Run anyway**.
- **macOS**: if Gatekeeper blocks it, allow it under **System Settings -> Privacy & Security ->
  "Open Anyway"**, or clear the quarantine attribute: `xattr -d com.apple.quarantine ./spritebook`
- **Linux**: mark it executable: `chmod +x ./spritebook`

Commands below are written as `./spritebook` — that form works in bash, zsh, and Windows PowerShell
alike (in classic `cmd.exe`, type `.\spritebook` instead).

## 3. Check your GPU

Baking renders on your GPU through WebGPU. Make sure the machine is ready first:

```
./spritebook doctor
```

Healthy output shows the product and render-pipeline versions, your adapter, the render signature
(the renderer + adapter identity that cache keys carry), and a passing render probe
(`render probe: OK`):

```
SpriteBook 0.9.0
deno 2.9.2 - v8 14.9.207.2-rusty - windows-x86_64
render pipeline spritebook-render@0.5.0
backend env: DENO_WEBGPU_BACKEND=(unset - wgpu default)
adapter: NVIDIA GeForce RTX 3090 (vendor 4318, device 8708)
render signature: spritebook-render@0.5.0#<adapter>
features: (none)
limits: maxColorAttachments=8 maxColorAttachmentBytesPerSample=32 maxTextureDimension2D=8192 maxBufferSize=268435456
render probe: OK (checksum 5f70bf18a0860070)
```

`doctor` exits 0 only when an adapter exists **and** the probe passes. If it prints `adapter: NONE`,
see Troubleshooting below.

## What the stages need

| Work                          | Needs                                                            |
| ----------------------------- | ---------------------------------------------------------------- |
| bake, style, export           | any WebGPU adapter — NVIDIA, AMD, Intel, Apple, or Mesa lavapipe |
| AI generation (`trellis2-4b`) | NVIDIA GPU with CUDA, 12 GiB VRAM, 16.4 GB disk                  |
| auto-rig (`unirig`, Track B)  | NVIDIA GPU with CUDA, 17.4 GiB VRAM, 5.8 GB disk                 |
| Track A rig, `fixture-gen`    | nothing extra — no GPU, no download                              |

The VRAM floors are measured, and the install warns on a smaller card. The
performance numbers later in this file come from one reference machine, an
RTX 3090; treat them as that machine's numbers, not promises.

## 4. Bake

```
./spritebook bake --model sample/asymmetric.glb --character hero --out bakes --style pixel --directions 8 --frames 6
```

```
queued
started
[1/4] cells
[2/4] pack
[3/4] write
[4/4] manifest
bake-manifest: bakes/bake-<id>/manifest.json
bake-dir: bakes/bake-<id>
done in 4.17s
```

The bake lands in a content-addressed directory, `bakes/bake-<id>/`. The id is the first 8 hex of
the recipe hash, and the recipe includes the render signature above — which is composed with an
identity hash of your GPU adapter, because a driver change can change pixels. So the same model and flags give you the same id every
time on one machine, and a different one on a machine with a different adapter. That is deliberate:
two adapters can rasterize the same scene differently, and sharing a cache entry between them would
serve pixels that were never rendered from this recipe here.

| File                                                                             | What it is                                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                                                                  | the canonical BakeManifest: every frame's atlas rect and pivot, provenance (inputs, render signature), metrics |
| `atlas_lit_0.png`                                                                | the styled spritesheet page(s) — what your game draws                                                          |
| `atlas_albedo_0.png` `atlas_normal_0.png` `atlas_depth_0.png` `atlas_mask_0.png` | AOV pages (arbitrary output variables: albedo, normal, depth, mask), rect-identical to the lit page — for dynamic lighting, outlines, custom shaders                     |
| `style-result.json`                                                              | the style stage's artifact: palette, flicker metric, warnings                                                  |
| `contact-idle.gif`                                                               | animated contact sheet for eyeballing the bake — review-only, not a game asset                                 |

## 5. Export

```
./spritebook export --bake bakes/bake-<id> --out exports --targets godot,aseprite,texturepacker,strips
```

(`bakes/bake-<id>` is the bake directory printed by step 4.)

```
queued
started
[1/4] godot
export-godot: exports/godot
[2/4] aseprite
export-aseprite: exports/aseprite
[3/4] texturepacker
export-texturepacker: exports/texturepacker
[4/4] strips
export-strips: exports/strips
done in 0.07s
```

One subdirectory per target:

| Target           | Files                                                          | Point your engine at it                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `godot/`         | `hero.tres` + `atlas_lit_*.png`                                | copy both into a Godot 4 project; assign `hero.tres` as the SpriteFrames of an `AnimatedSprite2D`; animations are named `idle_d00` ... `idle_d07`; leave `centered` on — see below |
| `aseprite/`      | `hero.ase.json` + `atlas_lit_*.png`                            | Aseprite: **File -> Import Sprite Sheet** on the PNG; the JSON is your reference for tags and durations                                                                            |
| `texturepacker/` | `hero.tp.json` + `atlas_lit_*.png`                             | Phaser 3: `this.load.atlas('hero', 'atlas_lit_0.png', 'hero.tp.json')`; frame names are `idle_d00_f000` etc.; set `frameRate` at anim creation (this format carries no durations)  |
| `strips/`        | `hero-idle-d<DD>-strip.png` per direction + `hero-strips.json` | hand-rolled loaders; the JSON carries cell size, per-direction pivots, and each strip's own `fps` and `loop` (top-level `fps` is only the default for untimed clips)               |

Multi-page bakes suffix the Aseprite/TexturePacker JSON per page (`hero_p1.ase.json`); animations
never span pages.

### Where the Godot node origin lands

The bake records a pivot per frame — with the default `feet-baseline` pivot, the character's feet.
Each `AtlasTexture` in `hero.tres` carries a transparent `margin` that puts that pivot at the middle
of the texture, so an `AnimatedSprite2D` with its **default `centered = true` and
`offset = (0, 0)`** puts the node origin on the feet. Place the node at a tile's floor position and
the character stands on it.

So: change nothing on the node. If you set `centered = false`, the sprite jumps by half the padded
texture — set `offset` yourself in that case. `manifest.json` has the exact `pivotPx` per frame if
you need it, and the TexturePacker and strips exports carry it too.

## Styles

| Style       | Look                            | Palette                  | Dither      | Outline | Alpha |
| ----------- | ------------------------------- | ------------------------ | ----------- | ------- | ----- |
| `cel-2`     | flat cel tones                  | adaptive, max 6 (OKLab)  | none        | 1 px    | 1-bit |
| `clean`     | the model as it is (no styling) | none                     | none        | none    | soft  |
| `pixel`     | classic pixel art               | adaptive, max 16 (OKLab) | 4x4 ordered | 0.5 px  | 1-bit |
| `painterly` | soft edges, larger tonal range  | adaptive, max 32 (OKLab) | none        | none    | soft  |

All four render supersampled and downsample with temporal stabilization (texel snapping, palette
hysteresis), so frames do not shimmer in motion.

**The snapshot recipe** — the truthful first look at a generation, before any styling:

```bash
spritebook bake --workspace <dir> --style clean --cell 128 --ppm 64
```

The palette size is a starting point, not a ceiling — `--colors <n>` takes 2 to 256 and refines
whichever style you picked.

### Retired style ids

A style id is recorded in the character's `look`, so a character baked by an earlier version keeps
the id it was baked with. Retired ids still resolve, with a warning naming the replacement:

| Retired        | Resolves to | Why                                                      |
| -------------- | ----------- | -------------------------------------------------------- |
| `pixel-8`      | `pixel`     | 8 colours became 16; the name no longer states a count   |
| `pixel-8-thin` | `pixel`     | outline experiments, now folded into `pixel`'s `widthPx` |
| `pixel-8-span` | `pixel`     | as above                                                 |
| `pixel-8-both` | `pixel`     | as above                                                 |

The replacement is not byte-identical to what the retired id produced, so check the first bake. The
next bake records the live id, and the warning stops.

## Flag reference

### `spritebook bake`

| Flag                    | Default       | Meaning                                                             |
| ----------------------- | ------------- | ------------------------------------------------------------------- |
| `--workspace <dir>`     | (off)         | a character directory; supplies the four rows below it              |
| `--model <path>`        | (required)    | rigged `.glb` to bake                                               |
| `--character <id>`      | (required)    | immutable character slug; binds cache keys                          |
| `--out <dir>`           | (required)    | bakes land at `<dir>/bake-<id>`                                     |
| `--camera <id>`         | `standard-30` | `low-15`, `two-to-one`, `standard-30`, or `isometric`               |
| `--style <id>`          | `pixel`       | `cel-2`, `clean`, `pixel` (16 colours), or `painterly`              |
| `--directions <n>`      | `8`           | `2`, `4`, `8`, or `16`                                              |
| `--frames <n>`          | `6`           | frames of the built-in idle pose (positive integer)                 |
| `--clips <spec>`        | (idle)        | `clip:frames[@speed][!hold][,...]` — bake real clips instead        |
| `--pack <dir>`          | (bundled)     | animation pack the `--clips` ids resolve in                         |
| `--cell <px\|WxH>`      | `112`         | output cell size; `112` is square, `96x128` is not                  |
| `--ppm <n>`             | `32`          | pixels per meter (world scale)                                      |
| `--colors <n>`          | style's own   | palette size, 2–256; refines the style rather than replacing it     |
| `--elevation <deg>`     | `30`          | camera elevation angle                                              |
| `--padding <px>`        | `16`          | transparent padding inside each cell; also holds the ground band    |
| `--cache <dir>`         | (off)         | input-hash frame cache; the bake always writes through when set     |
| `--only-invalidated`    | (off)         | serve unchanged frames from the cache (all-or-none per bake)        |
| `--mirror`              | (off)         | produce the back-half directions by flipping the front half         |
| `--no-mirror`           | (off)         | force mirroring off, overriding the character's own setting         |
| `--all`                 | (off)         | bake every character under `--root` (see below)                     |
| `--root <dir>`          | —             | the folder your character workspaces live in; required by `--all`   |
| `--changed-since <iso>` | (off)         | only characters whose manifest was written at or after this instant |
| `--plan`                | (off)         | print the plan and stop — render nothing                            |
| `--json`                | (off)         | NDJSON job events on stdout                                         |

With `--workspace <dir>`, `--model`, `--character` and `--out` become optional: the model is the
workspace's `canonical/model.glb`, the character is the id in its manifest, and bakes land in
`<workspace>/bakes/`. The character's own `look` (camera preset, style preset, and any overrides on
either) and its enabled `animationSet` bindings supply the defaults, so

```
spritebook bake --workspace ./characters/hero
```

reproduces that character's last bake exactly — same `bakeId`, every frame served from cache. Any
flag you do pass still wins, and what the bake ran with is written back to the manifest as one
undoable step (`look`, `animationSet`, `lastBakeId`).

Two things do not round-trip, by design. `--frames` is the frame count of the built-in idle pose,
which has no home in the manifest because frames are a per-clip setting (`--clips`, and
`animationSet` where they persist). And a stored clip binding names the pack it came from: if that
is not the pack this bake reads, the bake refuses rather than resolving the same clip id against
different animation.

`--mirror` renders only the directions that cannot be derived (5 of 8) and makes the rest horizontal
flips of their partner, cutting render, style and cache work by ~37%. It is **off by default and
never inferred from geometry**: for anyone asymmetric the saving is a lie — a tattoo changes arms, a
prosthetic swaps sides, text reads backwards. The bake warns for the whole run when it is on, and
each mirrored frame is marked in the manifest with the direction it was flipped from.

Under `--workspace` the choice persists like the rest of the look: `--mirror` once records
`mirroring.enabled` on the character, and every later bake mirrors without the flag. That is not
inference — it is the same explicit choice, made once and remembered, and the warning still fires
every run. `--no-mirror` is how a character that has said yes says no for a single bake.

#### Baking a whole roster

```
spritebook bake --all --root ./characters --plan
```

`--all` treats every directory under `--root` that holds a `character.json` as one character, and
bakes each with exactly the flags you typed. Before anything renders it prints a **plan** — per
character, whether a bake would do work, and which field of the recipe made it so:

```
plan for ./characters
  Bulma (bulma) — STALE, 96 frames to render
      · stylePresetHash: the style changed — a different preset, or an override on colors,
        outline, dithering, or supersampling
  Goku (goku) — fresh, 96 frames already baked
  Trunks (trunks) — BLOCKED
      · no canonical mesh on disk — generate one and pick it (`spritebook pick`) before baking
1 to bake · 1 fresh · 1 blocked · 96 frames to render, 96 already baked
```

`--plan` stops there. Without it the same plan is printed and then acted on. Either way two
documents land at the root: `roster.json` (the census) and `bake-plan.json` (what was decided and
why) — an overnight run that re-rendered everything is only diagnosable afterwards if the reasons
were written down beforehand.

`--changed-since <iso>` is a cheap prefilter on the manifest's modification time. It answers "was
this **touched**", which is a different question from "would its pixels **differ**" — a rename
touches the manifest and reaches no cache key, so a renamed character appears under
`--changed-since` and then plans as `fresh`. Both answers are correct and the plan shows both.

Bakes run one at a time and there is no flag to change that: each saturates the GPU, and two in one
process would interleave passes on shared render targets. One character failing never ends the run —
the rest bake, the failures are named in the summary, and the exit code is non-zero. Blocked
characters (no mesh, unreadable manifest, a look naming a preset that does not exist) are skipped
the same way rather than being silently dropped from the count.

#### The character must know its height

The cell math below assumes a character measured in metres. A generated mesh
keeps its backend's own scale unless `gen --height <metres>` declared one, and
a one-unit character bakes about 30 px tall at 32 px/m. The job warns when no
height was given and states what the character measures. Declare the height at
generation; see `docs/cli.md`.

#### Why the default cell is 112 px with 16 px of padding

Both numbers are measured, and they answer two different problems.

**The cell is sized for a CLIP SET, not a standing idle.** On the bundled Track A body at 32 px/m an
idle pose needs 37 x 63 px, while a six-clip set (idle, walk, jog, sprint, jab, death) reaches 37 px
left and 36 px right of the pivot and needs **85 x 73** — a jab and a death reach sideways in a way
a standing idle never does.

**The padding holds the GROUND BAND.** A `feet-baseline` pivot pins world Y=0 at one point — the
character's bounds centre — so at elevation the ground plane is not a screen row but a _band_: a
contact point `d` metres nearer the camera lands `d*sin(elevation)*pixelsPerMeter` pixels **below**
the pivot row, with every vertex still on or above the floor. The rows available down there are
`padding - 1`, **always**, whatever the cell height, because the pivot row is `h - padding`. A
bigger cell adds room above the character and none below it. Measured across the starter clip set
the band runs to 15 px below the pivot on a death animation, so 16 px of padding is what stops the
clipping.

The two interact: drawable width is `cell - 2*padding`, so 16 px of padding needs at least
`73 + 32 = 105` px of cell, rounded to 112.

One clip sets the padding budget — the death, because a body lying down has a footprint metres deep.
If you ship no deaths and no sword combos, `--padding 9 --cell 96` is measurably enough and saves a
third of the atlas. Both are recorded on the character's look like any other choice.

**Reading the flag.** `silhouette-clipped` on the **left or right** edge means the character outgrew
the cell — `--cell` is the answer. On the **bottom** edge it is the ground band: raise `--padding`,
lower the elevation, or lower `--ppm`. A bigger cell will not help. Only if the mesh itself is below
Y=0 in its bind pose is the character genuinely ungrounded, and the flag says how to check.

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
- **`SPRITEBOOK_REQUIRE_GPU=1`** — a repo/CI switch, not needed day-to-day. In the binary it only
  sharpens `doctor`'s failure message; `bake` always errors without an adapter.
- **Same model, different machine, different pixels** — expected. Pixels are deterministic per
  (pipeline version, adapter, driver); an adapter change deliberately misses the whole cache.
  `doctor` prints the render signature that identifies your combination. One caveat: a
  driver-version-only update does not change the signature — if you use `--cache` and just updated
  GPU drivers, delete the cache directory (or bake once without `--only-invalidated`).

## Performance

Reference numbers for the step-4 workload (bake 8 directions x 6 frames at the 112 px default,
`pixel` style, then export all four targets) — the roadmap bar is <=10 minutes cold:

- Dev GPU (RTX 3090, Vulkan, Windows, compiled binary): **~4.4 s** (bake 4.17 s + export 0.07 s).
- CI software rasterizer (ubuntu-latest, Mesa lavapipe): measured by the release workflow's Linux
  smoke on every tag push — the number is printed in that run's summary and uploaded as the
  `metric-linux` artifact. (Software rasterization is minutes-scale by design; it exists to prove
  the pipeline, not to race it.)
