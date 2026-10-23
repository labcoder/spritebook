# Windows preview beta 0.5.0

Requested scope: complete the existing Amy and Bulma projects into side-scrolling walk/jump sheets
and higher-resolution eight-direction isometric sheets. Preserve working source projects, use
incremental commits on main, and push/tag only after qualification. Engine import, signing and
notarization are outside this pass.

## Work sequence

- [ ] Capture recoverable character copies and baseline walk/jump motion, including skirt clipping.
- [ ] Improve generic humanoid skin ownership and garment motion; qualify both existing characters.
- [x] Extend the shared camera with perspective, yaw and configurable lighting; retain orthographic
      world scale and preview/bake parity.
- [x] Make Look a camera workbench with a fresh core-rendered frame, the existing unfiltered `clean`
      style presented as Original, and 64–4096 px output controls.
- [x] Keep Bake for whole animation sets and Export for delivery; support multipage high-resolution
      atlases and exporting the canonical GLB plus texture files.
- [ ] Export both game-view scenarios, inspect walk/jump sheets and validate output manifests/files.
- [ ] Review code/docs for beta polish and personal machine assumptions, align version metadata, run
      Windows checks, then push main and tag `v0.5.0`; follow CI to completion.

## Acceptance

Look previews come from the same render/style path as bakes. Viewport camera edits are recipe
drafts, not new output until core renders them. Source geometry/textures survive rig repairs. No
weakened deformation checks, per-character name/color exceptions or false cloth-simulation claims.
Exported pixels, pivots, animation timing and atlas rectangles agree across the native manifest and
selected engine formats. High-resolution qualification includes a real 4096 px render; complete
side/isometric sets may use smaller production-friendly cells.

The earlier Amy ownership defect remains an active reproduction, not an accepted limitation for this
beta qualification. Private character assets and local replay traces stay outside Git.

## Capture and delivery qualification so far

Core preview/bake crop parity passes for perspective and custom lighting. A real four-frame 4096px
Original bake completed on Windows; its atlas cells retain full resolution. The Studio capture
workbench and explicit multipage atlas bridge are implemented, and native cargo check passes.
Model-only export preserves GLB and texture bytes without requiring a bake. Full walk/jump garment
quality, final exported scenarios and release CI remain open. The donor-weight research is an
isolated experiment, not a shipped repair: see
[garment skinning research](garment-skinning-research.md).
