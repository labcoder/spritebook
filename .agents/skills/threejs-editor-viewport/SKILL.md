---
name: threejs-editor-viewport
description: Building and maintaining the GUI's three.js inspection viewports and their editor controls — rig inspector, socket placement, mesh preview, look-dev orbiting. Use this skill whenever adding or editing any 3D viewport code in apps/gui, including scene/renderer setup, WebGPURenderer or TSL usage, camera controls, transform gizmos, view cubes, object or bone picking, skeleton display, canvas resize/DPR handling, or viewport teardown. Also consult it before choosing any three.js API for materials or post-processing — the WebGPU renderer changed those rules.
---

# three.js editor viewports (GUI)

## The invariant that shapes everything

Viewports here are **inspection instruments, never pixel truth**. Final sprites are rendered by
`spritebook-core`; the GUI displays those frames as 2D images at integer nearest-neighbor zoom.
Never present a three.js render as output, and never let a user tune style against one — that
violates preview/export parity (decision D-006). This is why viewport code should stay visually
plain: helpers, standard materials, neutral lighting. If a viewport starts needing custom shaders,
question the requirement first.

## Version discipline

three.js releases roughly monthly and moves addon APIs freely. Pin an exact release; treat upgrades
as deliberate tasks that run the GUI visual checks. Types come from the community `three-ts-types`
package matching the pinned release. Import addons only from `three/addons/...` paths.

## Renderer

- Import from the WebGPU entry: `import * as THREE from 'three/webgpu'`. `WebGPURenderer` uses
  WebGPU when available and **falls back to WebGL 2 automatically** — the right behavior for a GUI
  that must run in whatever webview the shell provides.
- Initialization is **async**: `await renderer.init()` (or defer the loop until it resolves) before
  the first frame. Vite chokes on the entry's top-level await — set `build.target: 'esnext'` (and
  the same in `optimizeDeps.esbuildOptions`) in the Vite config.
- `ShaderMaterial`, `RawShaderMaterial`, and `onBeforeCompile()` are **not supported** by
  `WebGPURenderer`; custom materials must be TSL node materials, and post-processing uses the new
  node-based stack, not `EffectComposer`. For inspection viewports, avoid the issue entirely: stick
  to `MeshStandardMaterial`/`MeshBasicMaterial` and helpers, which keeps us off the TSL churn path.
- Do not reach for `forceWebGL: true` as a performance fix — it runs the node pipeline on WebGL and
  has been reported slower than either native path. If WebGPU underperforms in a given webview,
  measure before switching strategies.

## Camera controls

Use `camera-controls` (yomotsu) rather than `OrbitControls`: it provides smooth damping,
dolly-to-cursor, `fitToBox` (frame-selected — essential in an editor), and proper orthographic
support. Two integration requirements: call `CameraControls.install({ THREE: subset })` once at
startup, and call `controls.update(clock.getDelta())` every frame. Orthographic reminder: "zooming"
an ortho camera means changing `camera.zoom`, not dollying — `camera-controls` handles this
correctly; hand-rolled code usually doesn't.

## Transform gizmo

`TransformControls` (addon) is the move/rotate/scale gizmo:

- Recent versions split controls from their visual: add `controls.getHelper()` to the scene (the
  controls object itself is no longer an Object3D). Check the pinned version's pattern before
  copying old examples.
- Wire `controls.addEventListener('dragging-changed', e => cameraControls.enabled = !e.value)` — the
  classic bug is the camera orbiting while the user drags an axis.
- The attached object must already be in the scene graph. `attach(obj)` on select, `detach()` on
  deselect.
- Offer the standard editor keys (W/E/R for mode, Q for local/world space, hold Shift for snap via
  `setTranslationSnap`/`setRotationSnap`) — users arriving from Blender/Unity expect them.
- Socket placement = TransformControls attached to an empty `Object3D` parented to a bone; write
  back local offset to the manifest on `mouseUp`.

## View cube

Use `three-viewport-gizmo` for the corner orientation widget; it integrates with `camera-controls`
and `OrbitControls`. Wire its `start`/`end` events to disable/enable the camera controls, call
`gizmo.render()` after the main render each frame, and `gizmo.update()` on resize.

## Picking on rigged characters

`Raycaster` works for static meshes. For skinned meshes it tests the **bind pose**, not the current
animated pose — clicks miss once the character moves. Do what real editors do for bones and sockets:
project each joint's world position (`bone.getWorldPosition`) to screen space and pick the nearest
within a pixel radius. Use `SkeletonHelper` for display. Reserve mesh raycasts for un-animated
preview objects.

## Assets

Viewports load **canonical glTF from the asset store only** — the importer border has already
normalized formats, orientation, and scale. Never point `GLTFLoader` at raw user uploads from the
GUI.

## Resize, DPR, lifecycle

- Drive size from a `ResizeObserver` on the container: `renderer.setSize(w, h, false)` with
  CSS-sized canvas, `setPixelRatio(Math.min(devicePixelRatio, 2))`, update `camera.aspect` (or ortho
  frustum) + `updateProjectionMatrix()`.
- Tear down thoroughly on unmount: dispose geometries, materials, textures, `controls.dispose()`,
  `renderer.dispose()`. Assert `renderer.info.memory` returns to baseline in a leak test — editor
  GUIs that mount/unmount viewports leak by default.

## Architecture stance

Wrap each viewport in a plain TypeScript class (`init/attach/setSelection/dispose`) with an
event-emitter surface. The UI framework passes a container element and subscribes to events;
three.js never leaks into framework components. This keeps monthly three churn and any future
framework choice from touching each other.
