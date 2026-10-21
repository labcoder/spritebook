# SpriteBook concept context

<!-- impeccable:product-schema 1 -->

This record applies only to the unapproved visual studies in this folder. The
[PRD](../../docs/prd.md), [architecture](../../docs/architecture/architecture.md) and
[current design system](../../docs/design/design-system.md) remain canonical.

## Platform

web

The shipping application is a Tauri desktop shell containing React and Base UI. These studies are
standalone HTML, with no connection to the desktop bridge.

## Users and purpose

Solo and small-team 2D game developers turn character references or imported meshes into rigged,
animated models and engine-ready sprite sheets. Sprites are the product; 3D is part of the
production process. The application is local-first.

## Capabilities and constraints

Preserve Generate, Rig, Animate, Look, Bake and Export; the TypeScript core and CLI own behavior.
Preserve manifest patches, undo/redo, CLI twins, model admission gates, core-produced preview
pixels, asymmetric character details and integer sprite zoom. Canvas wells stay dark in both shell
themes. Do not change application source or the ratified design system until the maintainer selects
and approves a direction.

## Confirmed exploration scope

The maintainer wants visual style and identity first, using character editing and sprite preview as
the comparison surface. Present alternatives before implementation. All work stays local; publishing
to origin is prohibited until renewed instruction.

## Confirmed visual references, second round

The maintainer rejected Slate, Paper and Signal. They like the typography and visual style of
[Nous Research](https://nousresearch.com/) and the art direction of [Honcho](https://honcho.dev/),
explicitly including animated ASCII art, dithering and crosshatching. Translate those qualities into
a working editor; use original art and licensed type rather than copying either site's proprietary
assets. The first round is an anti-reference, not an approved identity. No second-round direction
has been selected yet.

## Evidence on hand

Current Studio source, the design system, docs/img/stage-04-look.png and the running browser demo
establish the incumbent UI. Previously qualified Pixal3D sprite output is available locally. Reused
output must be identified as prior evidence, not a fresh model run. Names and UI state invented for
the studies must be labeled sample data.

## Accessibility

Retain visible keyboard focus, sentence case, reduced-motion support, readable contrast and room for
localization. These drafts do not establish desktop accessibility or cross-platform qualification.
