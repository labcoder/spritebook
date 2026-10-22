---
name: "SpriteBook Studio"
description: "Imprint: a compact character workshop around core-produced sprites."
colors:
  dark-bg: "#1b2130"
  dark-panel: "#252e40"
  dark-chrome: "#202839"
  dark-raise: "#303e58"
  dark-footer: "#242e43"
  dark-line: "#3a4760"
  dark-line-strong: "#6c7b9a"
  dark-text: "#e1e6f0"
  dark-dim: "#a6b1c8"
  dark-accent: "#b7c6fa"
  dark-action: "#a9beff"
  dark-action-hover: "#c4d2ff"
  dark-on-action: "#18223f"
  dark-select-bg: "#2d3b59"
  dark-select-text: "#d1dcff"
  dark-current: "#2b3e6b"
  dark-on-current: "#dee7ff"
  dark-focus: "#c4d2ff"
  dark-ok: "#adcbbd"
  dark-warning: "#e1c48d"
  dark-danger: "#ffaea5"
  dark-on-danger: "#331c21"
  light-bg: "#f1f0e9"
  light-panel: "#f8f7f2"
  light-chrome: "#eeefea"
  light-raise: "#e3e7f0"
  light-footer: "#e1e5ee"
  light-line: "#b6bdcf"
  light-line-strong: "#7a86a9"
  light-text: "#303a66"
  light-dim: "#535e7c"
  light-accent: "#2d3d88"
  light-action: "#2d3d88"
  light-action-hover: "#23336f"
  light-on-action: "#fafaf5"
  light-select-bg: "#dee4f2"
  light-select-text: "#293a7c"
  light-current: "#2d3d88"
  light-on-current: "#fafaf5"
  light-focus: "#354ba8"
  light-ok: "#375f51"
  light-warning: "#765515"
  light-danger: "#9c393a"
  light-on-danger: "#fafaf5"
  check-a: "#171e28"
  check-b: "#1c232d"
  well-text: "#cfd8e4"
typography:
  display:
    fontFamily: "'Barlow Condensed', sans-serif"
    fontSize: "28px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "'Barlow Condensed', sans-serif"
    fontSize: "28px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "'Barlow Condensed', sans-serif"
    fontSize: "28px"
    fontWeight: 500
    lineHeight: 1.1
  body:
    fontFamily: "'Geist Mono', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'Geist Mono', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1
rounded:
  square: "0"
  menu: "2px"
  circle: "50%"
spacing:
  "4": "4px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
  "14": "14px"
  "16": "16px"
  "18": "18px"
  "28": "28px"
components:
  button-primary-dark:
    backgroundColor: "{colors.dark-action}"
    textColor: "{colors.dark-on-action}"
    rounded: "{rounded.square}"
    padding: "10px 18px"
  button-primary-hover-dark:
    backgroundColor: "{colors.dark-action-hover}"
  button-bordered-dark:
    backgroundColor: "{colors.dark-panel}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.square}"
    padding: "8px 14px"
  input-dark:
    backgroundColor: "{colors.dark-panel}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.square}"
    padding: "7px 10px"
  stage-current-dark:
    backgroundColor: "{colors.dark-current}"
    textColor: "{colors.dark-on-current}"
    padding: "10px 8px"
  chip-dark:
    backgroundColor: "{colors.dark-panel}"
    textColor: "{colors.dark-dim}"
    padding: "8px"
    typography: "{typography.label}"
  tag-dark:
    textColor: "{colors.dark-dim}"
    padding: "4px 6px"
    typography: "{typography.label}"
  character-card-dark:
    backgroundColor: "{colors.dark-panel}"
    textColor: "{colors.dark-text}"
    width: "264px"
    rounded: "{rounded.square}"
  button-primary-light:
    backgroundColor: "{colors.light-action}"
    textColor: "{colors.light-on-action}"
    rounded: "{rounded.square}"
    padding: "10px 18px"
  button-primary-hover-light:
    backgroundColor: "{colors.light-action-hover}"
  button-bordered-light:
    backgroundColor: "{colors.light-panel}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.square}"
    padding: "8px 14px"
  input-light:
    backgroundColor: "{colors.light-panel}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.square}"
    padding: "7px 10px"
  stage-current-light:
    backgroundColor: "{colors.light-current}"
    textColor: "{colors.light-on-current}"
    padding: "10px 8px"
  chip-light:
    backgroundColor: "{colors.light-panel}"
    textColor: "{colors.light-dim}"
    padding: "8px"
    typography: "{typography.label}"
  tag-light:
    textColor: "{colors.light-dim}"
    padding: "4px 6px"
    typography: "{typography.label}"
  character-card-light:
    backgroundColor: "{colors.light-panel}"
    textColor: "{colors.light-text}"
    width: "264px"
    rounded: "{rounded.square}"
---

# Design System: SpriteBook Studio

## Overview

**Creative North Star: "Imprint"**

Imprint is a compact character workshop: condensed indigo headings, precise monospaced controls,
fine crosshatch on the light workspace and sparse dither on blue-gray night surfaces. Solid panels
keep the texture behind the work; reference images and saved sprites occupy dark, untextured wells.

The [public design guidance](../../docs/design/design-system.md) owns the shared visual commitments.
This app-level record extracts the implemented system from [tokens](src/tokens.css),
[type](src/fonts.css) and [styles](src/styles.css); those source files remain authoritative.
[PRODUCT.md](PRODUCT.md) records product truth, while the
[surface brief](.impeccable/surfaces/apps-studio-src-app-tsx.md) owns this screen's composition.

**Key Characteristics:**

- Condensed display type paired with compact monospaced controls.
- Square fields, thin rules and solid indigo actions.
- Independent light/dark shells around unchanged sprite pixels.

## Colors

Deep indigo anchors the light shell; pale indigo sits on separately designed blue-gray dark
surfaces. Frontmatter keys follow the source role names, prefixed `light-` or `dark-`; `check-a`,
`check-b` and `well-text` are shared.

### Primary

- **Indigo:** `accent` colors the wordmark and stage heading; `action`/`on-action` and
  `action-hover` serve primary buttons.
- **Selection and location:** `select-bg`/`select-text` identify selected controls and roster
  entries; `current`/`on-current` identify the active stage. `focus` serves the keyboard outline.

### Neutral

- **Workspace and chrome:** `bg`, `chrome` and `footer` separate the textured workspace, title/index
  chrome and status bar.
- **Panels and rules:** `panel` fills fields and containers; `raise` serves hover and menu surfaces;
  `line` separates regions and `line-strong` outlines controls.
- **Text:** `text` carries reading content and `dim` carries supporting information. Shared
  `well-text` remains readable on the fixed checker.
- **Outcomes:** `ok`, `warning`, `danger` and `on-danger` describe status, never decorative stage
  colors. Keep the accompanying text and state marks.

**The Dark Well Rule.** Canvas wells use the shared checker and caption roles in both themes.
Workspace texture stays outside images and canvases.

## Typography

**Display Font:** Barlow Condensed (sans-serif fallback), self-hosted at weight 500. **Body / Label
Font:** Geist Mono (system-ui/sans-serif for body; monospace for compact labels), self-hosted at
weights 400–600.

The condensed face gives character names and stage titles a clear silhouette; the mono face aligns
controls, paths, measurements and CLI/log output. The hierarchy uses explicit sizes rather than a
computed type scale.

### Hierarchy

- **Display:** stage heading (`display`).
- **Headline:** compact SpriteBook wordmark (`headline`).
- **Title:** character names in the index and gallery (`title`).
- **Body:** general UI and controls (`body`); selected emphasis uses the existing 500/600 weights.
- **Label:** compact tags, chips and metadata (`label`); ordinary annotations remain at least 12px.
  Numeric metadata uses tabular figures.

## Layout

The 48px title bar uses a 28px wordmark. The gallery occupies the window without repeating its cards
in a character index; the 168px index appears only when editing. Stage headings are 28px. The
six-stage rail is flush with the editing region and divides its full width evenly. New character
shows that same rail with the later stages locked. Primary navigation retains keyboard focus when
changing surfaces.

Generate and Rig use a large canvas/reference region on the left and a 360px property panel on the
right. Each region scrolls independently. Creation and additional generation keep their action/CLI
footer visible while settings scroll. Native radio choices show an explicit selection marker;
installation state and VRAM stay beside names, while selected license details are disclosed.
Character, backend and generation controls form separate sections. Common generation controls stay
visible, advanced schema fields and comparison stay under Advanced options. All options still map to
the catalog and the existing CLI arguments.

Candidates occupy a shelf beneath their inspection canvas. Inspect and canonical promotion remain
visible; recipe variants and per-candidate CLI commands live under More actions. Optional texture
changes stay under Canonical mesh options. Rig places its actual deform report beneath the mesh;
orientation, re-run/repair and explicit acceptance occupy the property panel. File-based repairs are
disclosed. Canvas wells stay dark and source/output pixels are unchanged.

Running jobs show the reported stage and elapsed time. Their units have different costs, so the
activity indicator is indeterminate and supplies no invented job percentage or ETA. Stage details
retain raw counts. Cancellation has its own message and receives keyboard focus; failures keep their
reason. A disabled settings group remains scrollable by keyboard.

Inspector starts closed; on wide windows its existing resize range is 240–480px, with a 300px
default. Below 1100px it stacks beneath the stage. Below 760px the workbench panels stack, and the
rail uses two rows. These browser-preview adaptations do not add mobile platform support: the Tauri
window minimum remains 960×600.

Look retains its reference/saved-output comparison and recipe layout. Gallery cards retain their
fixed width and reflow without stretching sprite pixels. The typography, semantic palette and
workspace hatch/dither are preserved.

## Elevation & Depth

Tone and thin rules carry ordinary depth. The menu uses the existing smaller diffuse shadow; the
command palette and model dialog use the larger shadow over a dark scrim. Their exact CSS lives in
the [sidecar](.impeccable/design.json), alongside the two functional motion patterns: the
running-action spinner and progress-width transition. Reduced motion removes transitions and
animation.

**The Flat Surface Rule.** Ordinary panels use tone and thin borders. Menus and dialogs alone use
the existing overlay shadows.

## Shapes

Fields, action buttons and containers are square, outlined with thin rules. Menu triggers alone have
the small menu radius. Status dots and the busy ring are circular; this geometry does not extend to
container corners. The workspace hatch and dither are original static SVG textures, not content
overlays.

## Components

### Buttons

Solid primary actions use the action/on-action pair and a darker or lighter action-hover fill
appropriate to the theme. Bordered actions use panel/text, a strong border and a raised hover fill.
Menu actions stay compact and gain a raised hover/open background. Every keyboard target retains the
shared focus outline (2px, offset 2px); palette input moves it inside. Disabled actions fade;
running actions remain focusable with `aria-busy` and show the functional ring.

### Chips

Command and locale chips use panel/dim, a strong border and compact padding; hover raises the fill.
Status tags use thin borders and the semantic outcome roles. Selected segmented controls use the
selection pair; integer zoom controls use the action pair.

### Cards / Containers

Gallery cards have a fixed width, square corners, a dark checker thumbnail and an inset metadata
body. Hover/focus strengthens the border. Inspector sections and ordinary production panels use
solid panel surfaces and separating rules, without resting shadows.

### Model management

Manage models uses a single list with one recommended build per model. A condensed model name,
download size, memory requirement and a plain status carry the default row. Thin horizontal rules
separate models; metadata is not boxed into badges. Details discloses exact versions, platform and
license information, verification, repair and removal. Other versions preserves historical pins.
Confirmations disclose terms and the exact CLI action before work starts. Inline progress appears
immediately, shows real download bytes, and uses named indeterminate phases for dependency/native
setup. Errors disclose their full reason on request. Keep the shared focus trap and transfer focus
to running actions and completion messages.

### Inputs / Fields

Text and numeric fields use panel/text, a strong border, square corners and an accent caret. Look
recipe fields are 36px high; compact toolbar and model-option fields keep their existing measured
padding. Preserve the global focus outline and native select behavior.

### Navigation

The roster uses condensed character names and a selection fill; Up/Down retains its existing
selection behavior. Stage buttons combine number, label and state dot. The active stage has a solid
current fill plus an underline; locked stages stay keyboard-reachable and explain their lock.
Inspector is a disclosure, not a permanently competing column.

### Reference and saved output

Reference images fit inside a fixed dark well. Saved output reuses Bake's atlas player with one
comparison clock and a 4× initial Look zoom; each full saved cell remains keyboard-scrollable and is
initially positioned around its recorded pivot. Playback leaves user panning alone. The current
bridge exposes saved atlas page 1 only, which is labeled. Missing sources and missing bakes use
explicit text states.

**The Saved Pixel Rule.** Recipe edits leave saved sprites unchanged until Bake. Display full saved
cells at integer nearest-neighbor zoom; scrolling never trims or resamples them.

## Do's and Don'ts

### Do:

- Do consume semantic light/dark roles from tokens.css and preserve the shared well colors.
- Do use the self-hosted display and UI faces with their existing fallback stacks.
- Do preserve visible keyboard focus, reduced motion, localization growth and inspector access.
- Do keep outcome labels, the exact CLI twin, stale-frame cost and honest empty/error states.

### Don't:

- Don't invert the light palette to manufacture dark mode.
- Don't place shell textures, filters or recoloring over sprite pixels.
- Don't add decorative mascots, the rejected ASCII torus, notched buttons or entrance animation.
- Don't present a changed recipe as newly baked output or browser resizing as mobile/native
  qualification.
