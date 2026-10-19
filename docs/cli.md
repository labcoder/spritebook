# The CLI, stage by stage

This page covers the verbs that take an image to a rigged, animated character: `gen`, `pick`, `rig`,
`anim`, `look`, `retexture`, and `models`. The [quickstart](quickstart.md) covers `bake`, `export`,
and `doctor`.

Every verb accepts `--json` (jobs emit NDJSON events; queries emit one JSON document) and
`--log-append <file>` (append every event to a file). SpriteBook Studio runs these exact commands.
Each primary button in Studio shows the command it runs, with a **Copy** button.

The examples below use `./characters/hero` as the workspace. A workspace is one folder per
character. It holds `character.json` and everything the stages record.

Installed candidates include owned Node/uv and production importer assets. For source development,
`npm run cli -- <verb> ...` invokes the same compiled entry. Current real CUDA backends still need
explicit external source/environments and gated assets; read [sidecar setup](../sidecar/README.md)
and [licensing](licensing.md) before following their generation examples. `models install` verifies
catalog weights; it does not provision those optional environments.

## gen — image to candidate meshes

```
spritebook gen --workspace ./characters/hero --character hero \
  --image hero.png --model trellis2-4b --height 1.7
```

| Flag                  | Meaning                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--workspace <dir>`   | the character folder; created on first use                                                                                                                                                                         |
| `--character <id>`    | the character id: lowercase letters, digits, dashes                                                                                                                                                                |
| `--image <file>`      | the source image; stored content-addressed in the workspace. `trellis2-4b` needs a cut-out RGBA — run `prep` first when the image has a background                                                                 |
| `--model <id>`        | the gen3d backend: `trellis2-4b` (real, CUDA) or `fixture-gen` (synthetic, no GPU)                                                                                                                                 |
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

CAUTION: read [Licensing](licensing.md) before you sell work made with a downloaded backend. The
catalog badge names the MODEL license, not the whole stack; TRELLIS.2 output is not cleared for
commercial use today.

Set your expectation for `fixture-gen`: it turns the image's OUTLINE into a lathe-like solid body.
The geometry and texture depend on the image, so it exercises the whole pipeline, but it is a
stand-in, not a likeness. A likeness needs `trellis2-4b`, which needs an NVIDIA GPU.

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

| Flag               | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `--result <rN>`    | the result to promote to `canonical/model.glb`       |
| `--no-reproject`   | skip source-detail reprojection; it is ON by default |
| `--no-color-match` | skip source-colour matching; it is ON by default     |
| `--image <file>`   | a different reference image for the reprojection     |

The pick is a journaled decision. `spritebook undo` takes it back. The pick unlocks every later
stage.

## rig — a skeleton for the canonical mesh

```
spritebook rig --workspace ./characters/hero \
  --model ./characters/hero/canonical/model.glb --out ./characters/hero/rig
```

Two tracks. The default (no flag) is Track B: UniRig predicts a fresh skeleton on the GPU, about two
minutes. `--track-a` fits a bundled rigged body instead: deterministic, no GPU, no model download.

| Flag                                                       | Meaning                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `--model <glb>`                                            | the mesh to rig. CAUTION: the skinned result is promoted back onto this path |
| `--out <dir>`                                              | where the rig artifacts land                                                 |
| `--track-a`                                                | canonical body fit instead of the UniRig prediction                          |
| `--body <dir>`                                             | the body to fit (Track A); `ubc-male` and `ubc-female` are bundled           |
| `--height <metres>`                                        | standing height for the fit                                                  |
| `--face-front` `--feet-ground` `--center` `--rotate <deg>` | orientation fixes; each re-runs the rig                                      |
| `--edits <patch.json>`                                     | apply joint-position edits from the viewport's gizmo                         |
| `--auto-hints`                                             | turn the deform report into joint hints and re-run                           |
| `--rerun-with-hints`                                       | re-run with `--edits` as position hints                                      |
| `--backend <id>`                                           | the rig model; `unirig` is the default                                       |
| `--seed <n>`                                               | prediction seed (Track B)                                                    |
| `--no-deform-check`                                        | skip the test-pose deform report                                             |
| `--accept` / `--unaccept`                                  | record that you reviewed the rig (needs `--workspace`)                       |

Read the deform report before you accept. A bake with an unaccepted rig warns but still runs.
Acceptance is journaled; `undo` takes it back.

## anim — the clip library and your bindings

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

| Flag                                                                 | Meaning                                   |
| -------------------------------------------------------------------- | ----------------------------------------- |
| `--list`                                                             | the camera and style preset rosters       |
| `--camera <id>` `--style <id>`                                       | the presets to record                     |
| `--elevation --directions --ppm --cell --padding --colors --outline` | per-character divergences from the preset |

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
The cut-out lands there as `cutout.png`, beside a small preflight report. Feed that `cutout.png` to
`gen --image`. A clean PNG with transparency needs no prep; `gen` takes it directly.

## models — install, verify, remove

```
spritebook models list
spritebook models list --installed
spritebook models install trellis2-4b
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

No current catalog entry requires acceptance or excludes a territory, so the two gate flags stay
unused today. The gates exist so a future entry can carry them; the install stops and names the flag
when one does.

One backend has a gate OUTSIDE the catalog: TRELLIS.2's image conditioner is Meta's gated
`facebook/dinov3-vitl16-pretrain-lvd1689m` repository. Request access on that model's Hugging Face
page. Then authenticate with `huggingface-cli login`, or set the `HF_TOKEN` environment variable.
The sidecar's download uses that authentication.

## Sizes and floors

| Model         | Disk    | Minimum VRAM | Needs                |
| ------------- | ------- | ------------ | -------------------- |
| `trellis2-4b` | 16.4 GB | 12 GiB       | NVIDIA GPU, CUDA     |
| `unirig`      | 5.8 GB  | 17.4 GiB     | NVIDIA GPU, CUDA     |
| `rembg-u2net` | 0.2 GB  | —            | CPU                  |
| `fixture-gen` | none    | —            | nothing; no download |

The floors are measured, not copied from READMEs. An install on a smaller card warns; the job-time
preflight is the hard gate.

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
single minimum is advisory. See the [execution policy](architecture/execution-policy.md) for the
consent fingerprint, unmanaged behavior, renderer-pin boundary and qualification limits.

`gen --more-like <result>` reuses the result's recorded backend version as well as its parameters.
Explicit `--model` or `--model-version` requests a different choice; project pins still apply.
