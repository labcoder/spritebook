# SpriteBook

**One reference image in. Engine-ready character spritesheets out.**

SpriteBook is a free, local-first tool for 2D game developers. It converts a single character reference image into a rigged, animated 3D model, then renders that model into stylized, temporally-stable spritesheets — every animation, every direction, every frame — packed into atlases and exported for Godot, Aseprite, TexturePacker, and more.

## Why

2D sprite games face a combinatorial asset explosion: characters × animations × directions × frames. A 300-character roster with 10 animations, 8 directions, and ~8 frames each is **192,000 hand-drawn frames**. The classic industry answer — model once in 3D, render infinitely to 2D — powered Diablo, Factorio, and Dead Cells, but always required a 3D team and a homebrew pipeline. Open-weight image-to-3D and auto-rigging models make that pipeline automatable for one person. SpriteBook is that pipeline, productized: **the 3D is an implementation detail; the sprites are the product.**

## The pipeline

`01 Generate → 02 Rig → 03 Animate → 04 Look → 05 Bake → 06 Export`

Headless-first: everything is a CLI verb driven by manifests; the desktop GUI is a slim wrapper that shows its CLI twin for every action. See [`docs/prd.md`](docs/prd.md) for the product spec and [`docs/architecture/architecture.md`](docs/architecture/architecture.md) for the system laws.

## License

TBD — committed later (MIT recommended; the dependency BOM was cleared for a free, redistributable, commercial-friendly tool).
