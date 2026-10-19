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

## Documentation

| Doc                                                                                                                                                     | For                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [Quickstart](docs/quickstart.md)                                                                                                                        | the shortest path from a mesh to a spritesheet, on the CLI   |
| [User guide](docs/guide.md)                                                                                                                             | SpriteBook Studio, stage by stage                            |
| [Godot](docs/engines/godot.md) · [Unity](docs/engines/unity-texturepacker.md) · [Phaser](docs/engines/phaser.md) · [Aseprite](docs/engines/aseprite.md) | importing the exported files                                 |
| [Licensing](docs/licensing.md)                                                                                                                          | what you can ship, what installs behind gates, and the traps |
| [Platform support](docs/platform-support.md)                                                                                                            | what runs where                                              |

## Development

Use **Node 24.22.0** (the pin in `.node-version`), npm, and Rust/Cargo. Windows runtime packaging
also needs the Windows SDK's `mt.exe`. The repo is a locked npm workspace; product behavior remains
TypeScript, compiled to JavaScript, with Tauri/React for the desktop and Node/Dawn for rendering.

```sh
npm ci --ignore-scripts
npm run build                    # native ownership helpers, JavaScript and package assets
npm run check                    # separate source, test and frontend type checks
npm test                         # existing suites; explicit GPU/model/engine skips
npm run cli -- doctor

npm run dev:web -w spritebook-studio  # browser demo, port 5174
npm run dev:desktop               # real Tauri bridge; prepares the owned runtime first
npm run build:desktop             # local Windows NSIS candidate
npm run build:runtime             # complete portable CLI tree in .build/runtime

npm run lint
npm run fmt:check
npm run coverage
npm run hooks:install
```

The Python sidecar needs uv **0.12.10** for source development: `uv sync --project sidecar
--frozen`. Installed candidates include their own uv and create a lock-specific Python environment
in writable application data. Model weights, optional CUDA environments and backend code remain
separate prerequisites; see [sidecar setup](sidecar/README.md) and [licensing](docs/licensing.md).

For iterative work, run `npm run build:watch` and `npm run test:watch` in separate terminals. Tests
exercise emitted modules. Browser mode uses labeled demo data; real workspaces, jobs and thumbnails
use `dev:desktop`, whose bridge invokes the same compiled CLI.

The [migration roadmap](future/roadmap.md) records the Windows evidence and remaining gates. CI uses
Node on Linux, macOS and Windows, with a separate Linux lavapipe lane. Candidate artifacts are for
qualification: native platform execution, fresh model provisioning, signing and native notices
remain release gates. No Deno executable is needed for supported development, CI or application
flows. Pinned legacy sources remain available through Git for preserved-copy rollback.

## License

SpriteBook source code is licensed under the **GNU Affero General Public License version 3.0 only**
(see [LICENSE](LICENSE) and [NOTICE](NOTICE)).

**Outputs are yours.** Spritesheets, atlases, manifests, models, and any other assets produced by
running SpriteBook are _not_ subject to the AGPL solely because they were created with SpriteBook —
use them in personal, commercial, open-source, or proprietary projects freely. Attribution is
appreciated but not required; a suggested credit line is in [NOTICE](NOTICE).
