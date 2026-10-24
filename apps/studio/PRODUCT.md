# SpriteBook Studio

<!-- impeccable:product-schema 1 -->

## Platform

web

Studio is a Tauri desktop application containing React and Base UI. TypeScript on Node owns core
behavior; the browser demo is explicitly labeled and uses synthetic data.

## Users and purpose

Solo and small-team game developers turn character references or imported meshes into rigged,
animated models and engine-ready sprite sheets. Sprites are the product; 3D is part of production.
The [PRD](../../docs/developer/product.md) and
[architecture](../../docs/developer/architecture/architecture.md) remain canonical for product scope
and behavior.

## Capabilities and constraints

Preserve Generate, Rig, Animate, Look, Bake and Export. All capabilities have CLI equivalents;
mutations use journaled manifest patches. Keep undo/redo, model admission gates, verbatim logs,
core-produced sprite pixels and integer nearest-neighbor zoom. Inspection viewports are not output.
The supported qualification target is Windows x64; other platform gates remain on the roadmap.

## Confirmed brand commitments

The maintainer approved the [polished Imprint direction](../../future/ui-concepts/imprint/README.md)
for implementation: compact wordmark, deeper indigo, a crosshatched light workspace and an
independently designed dark theme. Keep canvas wells dark in both themes. Character editing and
sprite preview are the priority surfaces. The arbitrary ASCII torus was explicitly rejected.

## Evidence on hand

Real character source images and saved bake atlases come through the desktop bridge. The approved
study uses prior Pixal3D output; those private reference assets must not become bundled demo art.
Browser verification uses the existing, explicitly synthetic demo bridge.

## Accessibility

Sentence case, Lingui localization, visible keyboard focus, reduced motion, readable contrast and
window resizing are required. Browser evidence does not establish native accessibility
qualification.
