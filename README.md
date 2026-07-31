# SpriteBook

**One reference image in. Engine-ready character spritesheets out.**

SpriteBook is a free, local-first tool for 2D game developers. It converts a single character
reference image into a rigged, animated 3D model, then renders that model into stylized,
temporally-stable spritesheets — every animation, every direction, every frame — packed into atlases
and exported for Godot, Aseprite, TexturePacker, and more.

## Why

2D sprite games face a combinatorial asset explosion: characters × animations × directions × frames.
A 300-character roster with 10 animations, 8 directions, and ~8 frames each is **192,000 hand-drawn
frames**. The classic industry answer — model once in 3D, render infinitely to 2D — powered Diablo,
Factorio, and Dead Cells, but always required a 3D team and a homebrew pipeline. Open-weight
image-to-3D and auto-rigging models make that pipeline automatable for one person. SpriteBook is
that pipeline, productized: **the 3D is an implementation detail; the sprites are the product.**

## The pipeline

`01 Generate → 02 Rig → 03 Animate → 04 Look → 05 Bake → 06 Export`

Headless-first: everything is a CLI verb driven by manifests; the desktop GUI is a slim wrapper that
shows its CLI twin for every action. See [`docs/prd.md`](docs/prd.md) for the product spec and
[`docs/architecture/architecture.md`](docs/architecture/architecture.md) for the system laws.

## Development

The repo is a Deno workspace (`packages/*`; scaffolded at P1-T1, packages fill in over the roadmap
phases). Requires [Deno](https://deno.com) 2.9.x.

```sh
deno task dev             # the studio in a BROWSER (demo-data bridge, port 5174)
deno task dev:desktop     # the studio as the real desktop app (Tauri window;
                          #   first run compiles Rust - takes a few minutes)
deno task build:desktop   # packaged NSIS installer

deno task test            # all workspace tests
deno task test:watch      # test watcher
deno task lint            # deno lint
deno task fmt             # format (fmt:check in CI)
deno task coverage        # tests + coverage report
deno task hooks:install   # one-time: enables the conventional-commit hook
```

`dev` serves chrome/tokens/a11y against labeled demo data — real workspaces, the sidecar exam, and
thumbnails need the desktop shell (`dev:desktop`), whose bridge spawns the core CLI.

CI runs lint/format/tests on Linux, macOS, and Windows, plus a Linux lane with Mesa lavapipe
(software Vulkan) used by the render suites from P2 on. Platform targets and known gaps:
[`docs/platform-support.md`](docs/platform-support.md).

## License

SpriteBook source code is licensed under the **GNU Affero General Public License version 3.0 only**
(see [LICENSE](LICENSE) and [NOTICE](NOTICE)).

**Outputs are yours.** Spritesheets, atlases, manifests, models, and any other assets produced by
running SpriteBook are _not_ subject to the AGPL solely because they were created with SpriteBook —
use them in personal, commercial, open-source, or proprietary projects freely. Attribution is
appreciated but not required; a suggested credit line is in [NOTICE](NOTICE).
