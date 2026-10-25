# The CLI, stage by stage

This page covers mesh import and the image-to-character verbs: `import`, `gen`, `pick`, `rig`,
`anim`, `look`, `retexture`, `models`, `extensions` and permanent character deletion. The
[quickstart](quickstart.md) covers a complete example; [capture and export](capture.md) documents
`bake` and `export`.

Every verb accepts `--json` (jobs emit NDJSON events; queries emit one JSON document) and
`--log-append <file>` (append every event to a file). SpriteBook Studio runs these exact commands.
Each primary button in Studio shows the command it runs, with a **Copy** button.

The examples below use `./characters/hero` as the workspace. A workspace is one folder per
character. It holds `character.json` and everything the stages record.

Installed candidates include owned Node/uv and production importer assets. For source development,
`npm run cli -- <verb> ...` invokes the same compiled entry. Real CUDA backends use catalog-managed
external source/environments and gated assets; read [sidecar setup](../../sidecar/README.md) and
[licensing](../licensing.md). `models install` verifies weights and provisions a declared runtime;
`models setup` repairs that runtime while retaining verified weights.

## Find a command

```sh
spritebook --help
spritebook gen --help
spritebook help rig
spritebook models setup --help
spritebook --version
```

Running `spritebook` without arguments also shows help. Every command accepts `--help` or `-h`:
usage, options and examples appear before any model loads or project writes. Help does not append to
job logs. Add `--json` to return help as one JSON document, for example `spritebook rig --help
--json`. Invalid help commands return exit code 1 with an error.

Use space-separated option values (`--cell 512`, not `--cell=512`) and quote paths or names
containing spaces. Boolean switches such as `--upright` and `--face-front` take no value. Normal
commands return 0 on success and 1 on failure; jobs report the failure in their JSON event stream
when `--json` is selected. Keep stderr separate from stdout when parsing output.

For source development, build once with `npm run build`, then use `npm run cli -- --help` or `npm
run cli -- gen --help`. To parse JSON without npm's lifecycle banner, invoke `node
packages/cli/dist/entry.js <command> --json` directly. The installed runtime needs no separate Node
installation.

| Task                                        | Command                                   |
| ------------------------------------------- | ----------------------------------------- |
| Create from an existing mesh                | `import`                                  |
| Remove a background explicitly              | `prep` (also automatic in `gen`)          |
| Generate, select or repaint a candidate     | `gen`, `pick`, `retexture`                |
| Fit and review a skeleton                   | `rig`                                     |
| Select clips and check motion               | `anim`                                    |
| Set camera, light and sprite finish         | `look`                                    |
| Render and deliver sprite sheets            | `bake`, `export`                          |
| Read, rename, copy or delete projects       | `workspace`, `rename`, `clone`, `delete`  |
| Update decals and attachments               | `identity`                                |
| Move through manifest edit history          | `undo`, `redo`                            |
| Install or repair models and optional tools | `extensions` (`models` remains supported) |
| Diagnose runtime/GPU setup                  | `doctor`                                  |

Deletion requires the exact character ID in `--confirm`; it has no undo. Journal commands take a
manifest path, for example `spritebook undo --manifest ./characters/hero/character.json`.

## import — preserve a mesh or try the offline reference

```sh
spritebook import --workspace ./characters/reference --example
spritebook import --workspace ./characters/hero --model ./hero.glb --name Hero
```

Use a new workspace. `--character <id>` overrides the directory-derived id; `--height <metres>` sets
the declared height. The canonical importer preserves an existing skin and its materials. Imported
rigs start unaccepted: review walk and jump in Rig before accepting. Static meshes still need
rigging. Import is journaled and undo restores the previous empty state. `--example` uses the
already bundled CC0 humanoid, with no model downloads.

Height and grounding apply to the skinned surface as well as the static bounds. Static armature
wrappers are folded into the first joint without replacing weights or bind matrices. Animated
wrappers/root tracks that need coordinate conversion, inherited shear, and intermediate non-joint
wrappers inside a skin are refused with a preparation message; importing existing animation
libraries is a separate workflow.

Normalized 8/16-bit skin weights are decoded to canonical floats. Invalid zero-total, negative or
nonfinite weights refuse, as do extra influence sets: reduce to four influences per vertex before
importing. Unsupported data is not silently discarded from an authored rig.

## gen — image to candidate meshes

```
spritebook gen --workspace ./characters/hero --character hero \
  --image hero.png --model trellis2-4b --height 1.7
```

| Flag                  | Meaning                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--workspace <dir>`   | the character folder; created on first use                                                                                                                                                                         |
| `--character <id>`    | the character id: lowercase letters, digits, dashes                                                                                                                                                                |
| `--image <file>`      | the source image; retained content-addressed. Opaque sources are prepared automatically through installed `rembg-u2net`; valid RGBA cutouts pass through unchanged                                                 |
| `--model <id>`        | the gen3d backend: `trellis2-4b` (CUDA), `pixal3d` (CUDA), or `fixture-gen` (CLI default; synthetic, no GPU). Choose a real backend explicitly for image generation.                                               |
| `--model-version <v>` | pin a backend version; the highest installed one otherwise                                                                                                                                                         |
| `--height <metres>`   | the character's standing height. CAUTION: without it the mesh keeps the backend's own scale, and a one-unit character bakes about 30 px tall at the default 32 px/m. The job warns and states the measured height. |
| `--seed <n>`          | reproducibility; candidate `i` runs at seed + 1000·i                                                                                                                                                               |
| `--candidates <1..8>` | candidates in ONE job; the model loads once                                                                                                                                                                        |
| `--adjust k=v,k=v`    | backend knobs that diverge from the catalog defaults; the roster is below                                                                                                                                          |
| `--more-like <rN>`    | re-run result rN's recorded recipe with a new seed                                                                                                                                                                 |
| `--sidecar <dir>`     | the sidecar (the local Python helper that runs the AI models); the bundled one otherwise                                                                                                                           |
| `--models-dir <dir>`  | the models root; the OS default otherwise                                                                                                                                                                          |
| `--catalog <file>`    | a catalog override; the bundled one otherwise                                                                                                                                                                      |

Each candidate becomes a result `r1`, `r2`, … with a receipt, a canonical mesh, and a front-view
`thumb.png`. Nothing is chosen yet.

Read [Licensing](../licensing.md) for the selected recipe's model, conditioner and runtime terms.
TRELLIS.2/Pixal3D weights are MIT; the separately gated DINOv3 agreement still applies.

Set your expectation for `fixture-gen`: it turns the image's OUTLINE into a lathe-like solid body.
The geometry and texture depend on the image, so it exercises the whole pipeline, but it is a
stand-in, not a likeness. The real `trellis2-4b` and `pixal3d` recipes currently need NVIDIA CUDA.

### The knobs `--adjust` takes

Each backend declares its own. These are the ones `gen` accepts.

`trellis2-4b`:

| Knob                     | Default | Range                          |
| ------------------------ | ------- | ------------------------------ |
| `steps`                  | 12      | 1 to 50                        |
| `pipelineType`           | `512`   | `512`, `1024`, `1024_cascade`  |
| `guidanceStrength`       | 7.5     | 0 to 20                        |
| `textureGuidance`        | 3.5     | 1 to 20                        |
| `textureGuidanceRescale` | 0.2     | 0 to 1                         |
| `textureSize`            | 2048    | 1024, 2048, 4096               |
| `textureRetries`         | 2       | 0 to 12                        |
| `decimationTarget`       | 200000  | 10000 to 2000000               |
| `candidates`             | 1       | 1 to 8 (or use `--candidates`) |
| `lowVram`                | true    | true, false                    |

`pixal3d`:

| Knob               | Default | Range                          |
| ------------------ | ------- | ------------------------------ |
| `steps`            | 12      | 1 to 50                        |
| `fov`              | 0.2     | 0.05 to 1.5 horizontal radians |
| `textureSize`      | 2048    | 1024, 2048, 4096               |
| `decimationTarget` | 200000  | 10000 to 2000000               |
| `candidates`       | 1       | 1 to 8 (or use `--candidates`) |

Pixal3D uses the single-view 1024 cascade with stage offload and real NAF. Its explicit FOV controls
camera framing; no automatic camera model, multiview or Pixal retexture stage is installed.

`fixture-gen`: `tris` (2000; 64 to 20000), `textureSize` (512; 256, 512, 1024), and `candidates`.

Two rules. The seed has its own flag, so `--adjust seed=5` is refused. `resolution` belongs to
`retexture`, not to `gen` — a knob one operation takes and the other does not is named in the
refusal, with the roster the operation DOES take.

`spritebook models list --json` carries each version's knob sets and their bounds verbatim, from the
catalog your machine actually runs. A refused `--adjust` prints the roster too.

## pick — bless one result as the canonical mesh

```
spritebook pick --workspace ./characters/hero --result r1
```

| Flag               | Meaning                                             |
| ------------------ | --------------------------------------------------- |
| `--result <rN>`    | the result to promote to `canonical/model.glb`      |
| `--reproject`      | opt in to painting source detail onto the texture   |
| `--color-match`    | opt in to matching texture colours to the source    |
| `--no-reproject`   | legacy opt-out; overrides `--reproject`             |
| `--no-color-match` | legacy opt-out; overrides `--color-match`           |
| `--image <file>`   | reference override for the requested texture passes |

A plain pick copies the candidate byte-for-byte, preserving its geometry, materials and textures.
Texture passes are off by default. Reprojection assumes an aligned front reference; differences in
pose or proportions can distort the texture. Requested passes use the prepared cutout when present,
record the conditioning image hash, and fail without changing the canonical asset if that image is
missing. `--image` alone does not enable either pass.

The pick is one journaled decision, including any requested texture changes. `spritebook undo`
restores the previous canonical revision. The pick unlocks every later stage.

## rig — a skeleton for the canonical mesh

```
spritebook rig --workspace ./characters/hero \
  --model ./characters/hero/canonical/model.glb --out ./characters/hero/rig
```

Two tracks. The default (no flag) is Track B: UniRig predicts a fresh skeleton on the GPU, about two
minutes. `--track-a` fits a bundled rigged body instead: deterministic, no GPU, no model download.

| Flag                                                                   | Meaning                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `--model <glb>`                                                        | the mesh to rig. CAUTION: the skinned result is promoted back onto this path           |
| `--out <dir>`                                                          | where the rig artifacts land                                                           |
| `--track-a`                                                            | canonical body fit instead of the UniRig prediction                                    |
| `--body <dir\|ubc-male>`                                               | Track A body; `ubc-male` is portable, other bodies take explicit directories           |
| `--height <metres>`                                                    | standing height for the fit                                                            |
| `--upright` `--face-front` `--feet-ground` `--center` `--rotate <deg>` | straighten, face, ground and center in one UniRig rebuild; rotate takes 90, 180 or 270 |
| `--edits <patch.json>`                                                 | apply joint-position edits from the viewport's gizmo                                   |
| `--auto-hints`                                                         | turn the deform report into joint hints and re-run                                     |
| `--rerun-with-hints`                                                   | re-run with `--edits` as position hints                                                |
| `--backend <id>`                                                       | the rig model; `unirig` is the default                                                 |
| `--seed <n>`                                                           | prediction seed (Track B)                                                              |
| `--no-deform-check`                                                    | skip the test-pose deform report                                                       |
| `--accept` / `--unaccept`                                              | record that you reviewed the rig (needs `--workspace`)                                 |
| `--preview-joint <name>`                                               | CPU-only diagnostic bend on the workspace's canonical rig; no inference                |

Read the deform report before you accept. A bake with an unaccepted rig warns but still runs.
Acceptance is journaled; `undo` takes it back.

Orientation switches need no value except `--rotate`. They and joint-repair options apply to UniRig
only; template fitting refuses them rather than silently ignoring them. A rebuild uses the current
canonical mesh, and promotes its result through the journal.

To inspect the same ±30° joint bend used by the deform check:

```sh
spritebook rig --workspace ./characters/hero --preview-joint thigh_l --json
```

This writes `rig/deform-preview.glb`, with a four-second rest/positive/rest/negative/rest loop. It
needs no model installation or GPU, preserves the canonical rig and acceptance, and reports an
unknown joint without writing a preview. The GUI plays this core-generated animation and provides
pause and scrub controls. Passing this diagnostic does not prove anatomical correctness.

## anim — the clip library and your bindings

`spritebook anim --audition --workspace ./characters/hero` renders walking and jump
start/air/landing in four directions and measures detailed surface stretch and separation under 17
poses per motion. It uses the current rig, with no inference or downloads, and leaves acceptance,
clips, look and the selected bake unchanged. `spritebook anim --review --workspace ./characters/hero
--json` reads the current report; changed mesh bytes, bundled clips or renderer version invalidate
it. These sampled checks require visual review and do not certify anatomy, clothing coverage or
collision-free motion.

Add `--result r1` to audition a generated candidate before picking it. This makes one seed-0 UniRig
attempt in a derived workspace under `anim/candidates/`, then uses the same motion review. UniRig
must already be installed and admitted for this machine. Exact project model/pack pins are retained;
no downloads or automatic acceptance occur. Repeating an unchanged candidate/backend recipe reuses
its draft rig. `anim --review --result r1 --workspace <dir> --json` reads its source-bound report.
Changing candidate bytes or project pins invalidates that evidence. The parent selection and its
accepted rig are untouched; derived files still consume disk space.

If upright alignment refuses a candidate that is already standing correctly, uncheck **Stand model
upright** in its motion review, or add `--no-upright` to both candidate audition and review
commands. This preserves its up axis and makes a separate draft recipe; front-facing, centering and
grounding still apply. It never replaces the default attempt or retries automatically.

```
spritebook anim --list
spritebook anim --enable idle-loop:6,walk-loop:8@1.5 --workspace ./characters/hero
spritebook anim --preview idle-loop --workspace ./characters/hero
```

| Flag                                 | Meaning                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--list`                             | the bundled library: 86 clips with categories and tags                                                                                |
| `--tag <t>` `--category <c>`         | filter the listing                                                                                                                    |
| `--enable <specs>`                   | bind clips: `clip:frames[@speed][!hold]`, comma-separated. `speed` is a playback multiplier: `@1.5` plays the clip 1.5 times as fast. |
| `--disable <clipIds>`                | disable bindings; their numbers are kept                                                                                              |
| `--preview <clipId>`                 | retarget the clip onto this character once and write `anim/preview-<clip>.glb` for the viewport                                       |
| `--import-pack <dir>` `--into <dir>` | import an external clip pack                                                                                                          |
| `--packs <dir>`                      | a pack root override                                                                                                                  |

Enable and disable are journaled decisions. The bake samples exactly what the bindings record.

## look — the camera and style decision

```
spritebook look --list
spritebook look --workspace ./characters/hero --camera standard-30 --style pixel
```

| Flag                                                                         | Meaning                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `--list`                                                                     | the camera and style preset rosters                             |
| `--camera <id>` `--style <id>`                                               | the presets to record                                           |
| `--elevation --yaw --directions --ppm --cell --padding`                      | per-character camera framing                                    |
| `--projection orthographic\|perspective --fov <degrees>`                     | projection; perspective scale is measured at the pivot plane    |
| `--colors --outline --supersample <1..4>`                                    | palette, outline and output antialiasing                        |
| `--ambient <0..1> --light-yaw --light-elevation --light-frame camera\|world` | constant lighting recorded with the style                       |
| `--preview --clip <id> --frame <index> --direction <index>`                  | render one frame without recording the look or selecting a bake |

`look --preview` emits a `look-preview` artifact pointing to JSON with the PNG, core-retargeted GLB,
sample time and resolved recipe. It uses full-clip bounds and the same sampled pose/render/style
path as Bake. Adaptive palettes are provisional until the whole animation set is baked; unfiltered
`--style clean` previews match their corresponding bake pixels. Supersampling multiplies render
size, not output size: use `--cell 4096 --supersample 1` for a 4096 px frame. Capture sizes
exceeding the GPU's texture or readback-buffer limits fail before allocation; lower supersampling or
output size to recover. Large atlases use multiple pages, and review-only contact GIF cells are
capped at 256 px.

Only the divergences are recorded. A look change makes every baked frame stale; the stage states the
cost before you re-bake.

## retexture — keep the mesh, reroll the paint

```
spritebook retexture --workspace ./characters/hero --result r1
```

| Flag                                               | Meaning                                      |
| -------------------------------------------------- | -------------------------------------------- |
| `--result <rN>`                                    | the result whose canonical mesh is repainted |
| `--seed --adjust --model --model-version --height` | as in `gen`                                  |

The output is a NEW result with a new card. The surface is preserved; the vertex buffer is not.
Rebuild anything bound per-vertex, skin weights above all.

## prep — cut the subject out of a busy image

```
spritebook prep --image photo.png --out ./prep
```

`prep` removes the background with the `rembg-u2net` model (0.2 GB, CPU). `--out` names a folder.
The cut-out lands there as `cutout.png`, beside a small preflight report and `prep-meta.json`
recording the exact model and parameters. This command is useful for inspecting a cutout separately;
`gen --image` also prepares opaque images automatically. A clean 8-bit RGBA PNG with transparency
needs no prep. Both paths require an installed `rembg-u2net` when background removal is needed and
retain the registry's execution gates.

## models — install, set up, verify, remove

```
spritebook models list
spritebook models list --installed
spritebook models install trellis2-4b --accept-license
spritebook models setup trellis2-4b --accept-license
spritebook models install pixal3d --accept-license
spritebook models setup pixal3d --accept-license
spritebook models verify trellis2-4b
spritebook models rm trellis2-4b
```

`install` takes `<id>` or `<id>@<version>`. Every file downloads to a staging folder and must match
the catalog's size and sha256 pin before anything lands.

| Flag                                    | Meaning                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `--accept-license`                      | required when the entry's license needs explicit acceptance                                      |
| `--territory <ISO>`                     | your self-declared territory, when the license excludes some                                     |
| `--from <dir>`                          | offline install: take the files from a folder instead of the network. The hash pins still apply. |
| `--installed`                           | (`list`) only what is installed                                                                  |
| `--models-dir <dir>` `--catalog <file>` | root and catalog overrides                                                                       |

The complete TRELLIS.2 and Pixal3D versions require explicit acceptance of their recorded terms,
including the DINOv3 conditioner. Request personal access to
`facebook/dinov3-vitl16-pretrain-lvd1689m` on Hugging Face, then run `hf auth login` or supply
`HF_TOKEN`. The registry downloads and verifies its declared local files; inference does not contact
Hugging Face.

For a catalog version with a runtime recipe, `install` also prepares source and the frozen Python
environment. A setup failure retains verified weights and names `models setup <id[@version]>` as
recovery. `setup` reuses those weights, checks the same license/territory/platform gates and
publishes readiness only after native checks. Source code and wheels still need network access
during setup; `--from` supplies model files only. Current native setup is qualified on Windows x64
with NVIDIA CUDA; other native model targets remain F7 work.

`rm <id>` removes every version of that model; `rm <id>@<version>` removes only that version. It
deletes model files and the install receipt, preserving Python environments, shared caches and
workspace assets. See [model storage and removal](models.md#storage-and-removal) for a full reset.

## extensions — models, optional tools and bundled content

`spritebook extensions list [--installed] --json` returns one document with `models`, `tools` and
`content`. Models retain the existing list shape. Tool rows distinguish the selected installation,
managed copies, discovered executable paths, platform download and any verification issue. Content
is the bundled pack/preset inventory, not an executable plugin catalog.

`extensions install/setup/verify/rm <model[@version]>` forwards to the existing model commands;
`models` remains compatible. Blender has `install`, `use`, `verify` and `rm`; `use --path
<executable> --accept-license` selects an existing Blender 4.5 LTS without uninstalling it later.
Managed downloads are pinned, optional Windows x64 portable archives. `--tools-dir <dir>` selects a
separate machine tool root. `install --from <archive.zip>` preserves verification for offline reuse.

See [extensions](extensions.md) for exact commands, ownership, sizes, experimental quality status
and platform limits. These jobs do not modify character manifests or enable a new deformation
provider.

## Sizes and floors

| Model         | Declared model files | VRAM admission                   | Needs                |
| ------------- | -------------------- | -------------------------------- | -------------------- |
| `trellis2-4b` | 17.60 GB             | configuration-specific; 4–18 GiB | NVIDIA GPU, CUDA     |
| `pixal3d`     | 25.26 GB             | 24 GiB                           | NVIDIA GPU, CUDA     |
| `unirig`      | 5.82 GB              | 17.4 GiB                         | NVIDIA GPU, CUDA     |
| `rembg-u2net` | 0.18 GB              | —                                | CPU                  |
| `fixture-gen` | none                 | —                                | nothing; no download |

Model-file sizes exclude runtime environments, caches, download staging and outputs. An install on a
smaller card warns; job-time admission is the hard gate. Pixal3D's measured 17.53 GiB Torch peak on
a 24 GiB RTX 3090 does not qualify smaller cards; budget a 64 GiB host and roughly 45–50 GB free
disk for a fresh stack. See the [hardware/platform report](../../future/model-platform-spike.md) for
measurement limits and Mac/Linux candidates.

## Workspace queries and selected exports

Core owns workspace reads and recovers any committed pending transaction before returning data. The
shell uses these commands rather than scanning files or choosing a bake by directory age:

```sh
spritebook workspace --root ./characters --json
spritebook workspace --root ./characters --roster --json
spritebook workspace --workspace ./characters/hero --json
spritebook workspace --workspace ./characters/hero --bake --json
spritebook workspace --workspace ./characters/hero --thumb --json
spritebook workspace --workspace ./characters/hero --atlas --pass normal --json
spritebook export --workspace ./characters/hero --out ./export --targets godot --json
```

`workspace` returns one JSON document: workspace cards (including malformed manifests as `null` with
an error), a roster, a recovered character manifest, the selected bake and directory, or base64
display artifacts. `--thumb` returns a string or `null`; `--atlas` returns `{manifest, png}` or
`null`. A character without `lastBakeId` has no selected bake. A missing or invalid selected bake is
an error; core never substitutes another directory. Thumbnail clip names come from the selected
BakeManifest. Preview and export therefore follow undo/redo consistently.

The existing `export --bake <dir>` remains available for exporting a specific historical bake.
Choose either `--workspace` or `--bake`. All valued flags require one nonempty, space-separated
value; missing or repeated valued flags fail before jobs or workspace writes start.

## Exact project execution

`gen`, `retexture`, `rig`, `prep`, `bake` and `anim` accept `--pins <file>`. Workspace jobs also
check `<workspace parent>/pins.json` automatically. The document uses the existing shape:

```json
{ "models": { "fixture-gen": "1.0.0" }, "packs": { "ual": "1+2" }, "rendererVersion": "legacy" }
```

Managed model/pack execution needs an exact matching pin. Missing installs, corrupt files,
unaccepted declared terms, excluded territories and unsupported platforms refuse before inference;
missing pinned versions never select a newer install. Standalone jobs without a pins file retain
their existing version selection. Receipt verification rehashes model files on each execution. `rig`
also accepts `--catalog <file>` for the same catalog override as generation/preparation.

Memory admission uses the effective configuration's catalog profile, not another configuration's
minimum. Unmeasured combinations refuse. `models list --json` exposes these profiles; its historical
single minimum is advisory. See the
[execution policy](../developer/architecture/execution-policy.md) for the consent fingerprint,
unmanaged behavior, renderer-pin boundary and qualification limits.

`gen --more-like <result>` reuses the result's recorded backend version as well as its parameters.
Explicit `--model` or `--model-version` requests a different choice; project pins still apply.

## Model delivery and preview queries

`export --workspace <dir> --out <dir> --mesh` exports the canonical `model/model.glb` byte-for-byte,
plus its embedded texture files and `textures.json`. It includes a saved rig when present and needs
no bake. Combine `--mesh` with `--targets godot,strips` to deliver sprites and the 3D asset
together. Sprite exporters remain projections of BakeManifest; model delivery is a separate
artifact.

`workspace --workspace <dir> --atlas --pass lit --page 1 --json` reads a specific selected atlas
page (indices start at 0). `workspace --workspace <dir> --look-preview <20-hex-key> --json` reads
the metadata for a core-produced frame preview. It cannot read arbitrary paths.

## delete — permanently remove a character's generated files

```sh
spritebook delete --workspace ./characters/hero --confirm hero
```

`--confirm` must match the immutable character ID in that workspace. Deletion has no undo and
refuses while another job owns the character. It removes SpriteBook-owned generated trees,
preparation derivatives, manifest and journals. The original external input, retained original
source copies, unrecognized user files, exports outside the workspace and machine installations
remain. Source and lock files can leave a nonempty directory after the character disappears from the
gallery.

The manifest is removed last. A locked file or other cleanup failure reports an error and retains
the manifest so the same command can retry; some generated files may already be gone. Back up the
complete workspace before deleting if you may need to edit it again. See
[projects and files](projects.md#delete-a-project) for the equivalent Studio confirmation flow.
