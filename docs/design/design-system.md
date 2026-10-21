# SpriteBook design system

**Imprint was approved by the maintainer on 2026-10-20**, superseding the July diagnostic identity.
The [approved light/dark study](../../future/ui-concepts/imprint/README.md) establishes the visual
direction. Studio remains Tauri/React with a TypeScript core on Node. The [guide](../guide.md)
describes current behavior; remaining editor capabilities belong to [F5](../../future/roadmap.md).

## Commitments

1. Colors live in semantic light/dark pairs in `apps/studio/src/tokens.css`. Components use roles,
   not raw palette values. Dark is designed independently, never produced by inversion.
2. Text meets WCAG AA; controls have visible borders and a 2px focus outline. Preserve keyboard
   operation, reduced motion and the existing focus restoration paths.
3. Copy uses sentence case and Lingui from the first string. Allow localization growth and window
   resizing without hiding controls.
4. Canvas wells remain dark in both themes. Shell textures never cover reference images, sprites or
   inspection canvases.
5. Sprite pixels come from core output and display nearest-neighbor at integer zoom. Three.js is for
   inspection; a changed recipe must not imply the saved bake has already changed.
6. Actions retain CLI twins, journaled manifest patches, undo/redo, honest model admission gates and
   verbatim session logs.

## Palette

The CSS is authoritative; `apps/studio/tokens_test.ts` checks contrast for actual surface roles,
action/selection states and fixed preview surrounds.

| Role                  | Light                       | Dark                      |
| --------------------- | --------------------------- | ------------------------- |
| Workspace             | `#F1F0E9` + fine crosshatch | `#1B2130` + sparse dither |
| Title chrome          | `#EEEFEA`                   | `#202839`                 |
| Fields/panels         | `#F8F7F2`                   | `#252E40`                 |
| Hover/raised          | `#E3E7F0`                   | `#303E58`                 |
| Footer                | `#E1E5EE`                   | `#242E43`                 |
| Primary text          | `#303A66`                   | `#E1E6F0`                 |
| Secondary text        | `#535E7C`                   | `#A6B1C8`                 |
| Brand/accent          | `#2D3D88`                   | `#B7C6FA`                 |
| Primary action / text | `#2D3D88` / `#FAFAF5`       | `#A9BEFF` / `#18223F`     |
| Action hover          | `#23336F`                   | `#C4D2FF`                 |
| Selection / text      | `#DEE4F2` / `#293A7C`       | `#2D3B59` / `#D1DCFF`     |
| Current stage / text  | `#2D3D88` / `#FAFAF5`       | `#2B3E6B` / `#DEE7FF`     |
| Separator             | `#B6BDCF`                   | `#3A4760`                 |
| Field border          | `#7A86A9`                   | `#6C7B9A`                 |
| Focus                 | `#354BA8`                   | `#C4D2FF`                 |
| Success               | `#375F51`                   | `#ADCBBD`                 |
| Warning               | `#765515`                   | `#E1C48D`                 |
| Error                 | `#9C393A`                   | `#FFAEA5`                 |
| Canvas checker        | `#171E28` / `#1C232D`       | Same                      |
| Canvas captions       | `#CFD8E4`                   | Same                      |

Status colors describe outcomes; stages no longer have separate subsystem hues. State is also
expressed through labels, current-step semantics, dots and lock explanations.

## Type and texture

- **Barlow Condensed 500**: 36px SpriteBook wordmark, 44px stage heading and character names.
- **Geist Mono 400–600**: 13px UI body, controls, measurements, paths and CLI/log lines; compact
  annotations remain at least 12px. Use system fallbacks for unsupported glyphs.
- Both faces are self-hosted under SIL OFL 1.1 with complete notices and source/SHA pins in
  `apps/studio/public/fonts/`. Retired fonts are no longer bundled by Studio.
- Original static hatch/dither geometry lives in `apps/studio/public/textures/`. No decorative
  mascot, ASCII torus, notched buttons, glow, or page entrance animation.

## Components and copy

Base UI supplies existing headless menu and dialog behavior. Hand-authored CSS supplies the
identity: square fields, restrained rules, solid action fills and consistent hover/focus states. Do
not add a styled component kit for this rollout.

Verbs name outcomes: "Generate model", "Save canonical mesh", "Accept rig", "Record look", "Export
selected". Show stale-frame cost before recording a changed look. Display license, territory and
VRAM gates before download or execution. Running actions stay focusable with `aria-busy`; errors
preserve the CLI reason and recovery path.
