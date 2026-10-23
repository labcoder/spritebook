# Windows preview beta 0.5.0

Requested scope: complete the existing Amy and Bulma projects into side-scrolling walk/jump sheets
and higher-resolution eight-direction isometric sheets. Preserve working source projects, use
incremental commits on main, and push/tag only after qualification. Engine import, signing and
notarization are outside this pass.

## Work sequence

- [x] Capture recoverable character copies and baseline walk/jump motion, including skirt clipping.
- [ ] Improve generic humanoid skin ownership and garment motion; qualify both existing characters.
- [x] Extend the shared camera with perspective, yaw and configurable lighting; retain orthographic
      world scale and preview/bake parity.
- [x] Make Look a camera workbench with a fresh core-rendered frame, the existing unfiltered `clean`
      style presented as Original, and 64–4096 px output controls.
- [x] Keep Bake for whole animation sets and Export for delivery; support multipage high-resolution
      atlases and exporting the canonical GLB plus texture files.
- [x] Export both game-view scenarios and validate output manifests, alpha, timing and strip pixels.
- [ ] Pass visual motion review, including hand/trouser ownership and skirt clearance.
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
Model-only export preserves GLB and texture bytes without requiring a bake. Four source-checkout
scenarios produced 720 frames; an additional packaged Node 24.22 replay produced Bulma side views
(72 frames, 512px) and Amy isometric views (288 frames, 1024px), including combined sprite/model
delivery. All exported frames are nonempty, atlas rectangles are in bounds, Godot resources parse
against the manifests, timing agrees, and sampled strip crops match atlas pixels exactly. Real 64px
pixel and 4096px Original previews also pass on the owned runtime.

The complete suite passes on Node 24.22: 923 tests pass and seven gated checks skip. The Windows x64
0.5.0 installer builds. Metadata is prepared but unreleased; no push, tag or new hosted CI run has
occurred. Live character manifests and canonical GLB hashes remain unchanged.

Capture was reviewed in light and dark themes at 1280×720. A five-second browser proof on the
800k-triangle character averaged 139.8fps idle and 100.1fps during continuous inspector resizing,
with zero asset reloads or renderer errors. This is browser frame cadence, not packaged WebView2 or
minimum-spec qualification. The manual design detector found only the approved Geist Mono face and
existing palette/type-ramp advisories; the capture, export and atlas-player surfaces also received
visual review.

Full walk/jump garment quality and release CI remain open. The donor-weight research is an isolated
experiment, not a shipped repair: see [garment skinning research](garment-skinning-research.md).

## Motion gate and next work

Amy's contacting hand/trouser region still produces incorrect skin ownership. Nearest donor,
geometric-prior and distance-only trials fail the raised-arm review. Bulma's skirt is heavily
distorted by the existing LBS weights before contact correction. Topology-aware masks and a real
Blender cloth-cage spike reduce some errors but still leave penetration or visible garment damage.
No experimental weights, corrective morphs, new dependencies or relaxed validation ship.

The next repair must qualify anatomical surface ownership and garment deformation together, with
source-detail collision checks across full walk/jump sequences. A successful low-resolution cage
alone is insufficient. Keep source geometry/textures recoverable and use the same correction in core
preview and bake. Restoring mesh-based character creation in the GUI remains later work; canonical
mesh import is still available in core.

Keep the requested `v0.5.0` publication gate closed unless the maintainer explicitly changes this
scope to a capture/export preview with documented motion limitations. Signing, notarization,
additional native targets and engine-import qualification remain outside this requested Windows
pass.
