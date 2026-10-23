# SpriteBook design system

**Imprint was approved by the maintainer on 2026-10-20**, superseding the July diagnostic identity.
The [approved light/dark study](../../future/ui-concepts/imprint/README.md) establishes the visual
direction. Studio remains Tauri/React with a TypeScript core on Node. The [guide](../guide.md)
describes current behavior; remaining editor capabilities belong to [F5](../../future/roadmap.md).
The [app-level design record](../../apps/studio/DESIGN.md) extracts implemented tokens and component
patterns for subsequent UI work.

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

- **Barlow Condensed 500**: 28px SpriteBook wordmark and character names.
- **Geist Mono 400–600**: 13px UI body, controls, measurements, paths and CLI/log lines; compact
  annotations remain at least 12px. Use system fallbacks for unsupported glyphs.
- Both faces are self-hosted under SIL OFL 1.1 with complete notices and source/SHA pins in
  `apps/studio/public/fonts/`. Retired fonts are no longer bundled by Studio.
- Original static hatch/dither geometry lives in `apps/studio/public/textures/`. No decorative
  mascot, ASCII torus, notched buttons, glow, or page entrance animation.

## Components and copy

The 48px title bar centers File/Edit, model access and a sun/moon theme toggle. Choose language
under Edit → Language; File → Shortcuts opens the existing command palette (Ctrl+K). GPU
identification is plain status text beside the bottom log handle. The gallery uses the full window;
editing adds the 168px character index. The flush six-stage rail provides the stage name, without a
duplicate title row.

Each stage has assets/output left and one property inspector right, extending from the rail to the
bottom. Its heading is the character name. The 360px default width persists locally and resizes
between 280–560px by drag or keyboard (Left/Right, Home/End; double-click resets). The edge chevron
collapses it to 40px without resetting drafts/jobs. The old separate manifest-summary column is
removed. At the 960×600 desktop minimum these remain two columns; below 760px browser panels stack.

Settings and assets scroll independently; generation, Rig, Look and Export keep action/CLI footers
visible. Native model radio choices emphasize names, install state and memory needs. Advanced
settings and selected terms are disclosed. The synthetic fixture is under Development tools in dev
builds and absent from production generation/model-management lists. Core catalog/CLI access and
existing project provenance are retained. Generation chooses an installed visible backend by
default; explicit choices and visible prior-result backends win.

Candidates stay below their canvas, deformation reports below the rig mesh, and clip/library
controls beside core-retargeted motion. Generate/Rig activity shows actual phases and elapsed time
without fabricated percentages or ETAs. Cancellation and errors retain clear status and focus.

Look shows source and saved sprites on the left, with its recipe and recording action on the right.
The comparison reuses Bake's atlas player with one clock for its directions. Clip and 1×/2×/4×/6×
zoom are view controls, not manifest changes. Look opens at 4x, positioning each scrollable full
cell around its recorded pivot. Subsequent user panning is preserved during playback. The bridge
currently supplies page 1 of the saved atlas; only frames on that page are shown. Large integer zoom
scrolls within the well rather than resampling pixels. Missing sources and absent bakes have
explicit empty states. Extra camera controls remain under "Camera and style details"; stale-frame
cost and the exact CLI twin stay beside "Record look". A recipe edit leaves saved sprites unchanged
until another bake.

Base UI supplies existing headless menu and dialog behavior. Hand-authored CSS supplies the
identity: square fields, restrained rules, solid action fills and consistent hover/focus states. Do
not add a styled component kit for this rollout.

Verbs name outcomes: "Generate model", "Save canonical mesh", "Accept rig", "Record look", "Export
selected". Show stale-frame cost before recording a changed look. Display license, territory and
VRAM gates before download or execution. Running actions stay focusable with `aria-busy`; errors
preserve the CLI reason and recovery path.

## Rig inspection

Use outcome names for the two methods: UniRig preserves geometry; template fitting replaces it.
After the first rig, disclose the rebuild method so the orientation controls have room. Group
upright alignment, facing, grounding and centering into one explicit rebuild. First builds enable
these choices with an upright opt-out; existing rigs lead with Auto align and rebuild rig and
disclose manual adjustments. Camera views remain separate from model transforms. Position hints and
raw edits-file paths stay under Repair tools.

Skeleton lines and joint markers render through the mesh by default. Blue is not flagged, amber is
flagged for surface review, white is selected; a text legend and the unchanged report carry the same
meaning. Report rows select and frame joints. Diagnostic motion comes from core; the GUI only plays
it. Acceptance remains a deliberate review action. Never label an unflagged joint anatomically
correct. Call the report Bend checks, explain that joint placement and surface motion differ, and
show the fraction of stretched edges beside the worst edge. Separate mesh parts are neutral
information; clothing is not automatically broken. Show predicted/named joint counts and limited
hand mapping without promising articulated fingers from a GPU run.

Motion check lives in the Rig inspector and reads the same catalog as Animate. It plays a
core-retargeted clip before acceptance, without enabling it. The active preview retains its CLI
twin; Return to rest pose restores editing. Keep pending edits blocked and report transport failures
without leaving the control busy. This review capability does not imply that binding or clothing has
been repaired.

## Implementation verification

The identity implementation has 67 Studio tests, alongside TypeScript and production web-build
checks. Browser checks cover the six stages, gallery, models, command palette, logs, locked/error
states and locale growth. Automated WCAG A/AA scans found no violations in those checked states. The
shared inspector was checked at 1440×900 and the 960×600 desktop minimum without horizontal page
overflow, including expanded locale text; playback, integer zoom, recipe/reset behavior and
theme-invariant canvas pixels were checked separately.

The guide includes current [light](../img/stage-04-look.png) and
[dark](../img/stage-04-look-dark.png) UI captures from the explicitly synthetic production browser
demo. The private saved-asset replay separately checks character layouts without writing project
files or running inference. Native Tauri packaging, platform accessibility and hardware
qualification were not rerun; F7 remains open. This is an F5-T1 layout refinement, not completion of
the full editor roadmap.
