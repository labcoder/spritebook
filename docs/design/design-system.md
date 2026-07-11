# SpriteBook — design system

Direction locked in UX passes 01–04: **Marathon / Ghost-in-the-Shell Neo-Tokyo** — acid hues as functional color coding on charcoal, tiny mono annotations, everything labeled like a diagnostic readout. **Token values below are PROVISIONAL** (waiting on the maintainer's color-system examples); structure and rules are final — final values drop into the semantic layer without layout changes.

## Hard commitments (non-negotiable, hold regardless of final palette)

1. **Every color is a semantic light/dark token pair.** No raw hex in components.
2. **WCAG 2.1 AA** for text and interactive states; visible focus (cobalt ring); full keyboard operability; reduced-motion respected.
3. **i18n from the first string** — ICU MessageFormat via Lingui; no concatenated sentences; layouts survive +40% string growth.
4. **Canvas wells stay dark and checkered in BOTH themes.** Pixel color judgment needs a neutral dark surround.
5. **Acid hues are fills, never text on light surfaces.** Light theme uses ink-darkened accent variants for text.
6. **Pixel truth is sacred:** core-rendered frames display nearest-neighbor at integer zoom only. Three.js viewports are inspection instruments, visually plain, never presented as output.

## Provisional tokens

| Token | Dark | Light ("printed spec sheet") | Use |
|---|---|---|---|
| `surface/bg` | `#141416` | `#ECE9E0` (paper) | app background |
| `surface/panel` | `#1B1B1F` | `#F6F4ED` | rails, inspector, bars |
| `surface/raise` | `#232329` | `#E2DFD4` | cards, inputs |
| `line` | `#32323A` | `#CDC9BB` | borders, tick rules |
| `text` | `#E7E4DC` | `#191A1C` | primary text |
| `text/dim` | `#8F8D96` | `#66646C` | secondary |
| `accent/acid` | `#C6DC34` | fill same; text-ink `#67750A` | primary action, GEN, ok |
| `accent/magenta` | `#DD3FD3` | fill same; text-ink `#A31896` | selection, RIG |
| `accent/cobalt` | `#5A6BF0` | `#3140C4` | links, focus, ANIM |
| `accent/cyan` | `#55D0D6` | `#2FA9B0` | in-progress, LOOK |
| `accent/sun` | `#E8C226` | `#C79A12` | warnings, BAKE |
| `accent/signal` | `#E23B2E` | `#C6301F` | errors, flags |
| `well/checker` | `#232329` / `#1B1B20` | same (rule 4) | canvas wells |

**Hue codes the pipeline:** chartreuse GEN · magenta RIG · cobalt ANIM · cyan LOOK · sun BAKE · text EXPORT — used in the stage rail chips, tab accents, and progress fills. Color = subsystem identity (the Marathon move).

## Type & texture

- **Chakra Petch** (600/700, uppercase, tracked) — HUD labels, stage names, buttons, tab titles.
- **IBM Plex Sans** — body/UI copy. **IBM Plex Mono** — every value, seed, hash, path, CLI line, log line.
- All three SIL OFL 1.1. Motifs: single 45° notched corner on primary surfaces/buttons; **segmented (frame-stepped) progress bars** — progress fills in discrete cells, never smooth gradients; tick-rule dividers; mono annotation eyebrows (`01// GEN`).

## Chrome specification (from UX passes 03–04)

- **Menu bar:** logo mark far left (4-quadrant chip in pipeline hues — placeholder until brand pass) + wordmark; File / Edit / View / Character / Bake / Window / Help; right: ⌘K, theme toggle, GPU chip. **File ▸ Manage models… (⌘M).** Edit carries Undo/Redo (journaled patches) and Duplicate character (⌘D).
- **Character tabs** across the top (browser-style, `+` to add; MVP renders one; pattern scales).
- **Stage rail** left: vertical stepper `01 Gen … 06 Export` with hue chips; stages 02–06 locked until canonical mesh saved, unlock condition stated inline; collapsible to icons.
- **Inspector** right: contextual, sectioned with collapse carets, scrollable; **resize grip** between center and inspector. Panel state persists in machine-local `UiLayoutPrefs`.
- **Status bar:** queue state, cache %, GPU/backend, version — and the **log drawer handle**: expands upward into the raw NDJSON stream with severity filters and copy; errors badge the collapsed handle in signal red. Nothing fails silently.
- **Every primary action shows its CLI twin** (copy-as-CLI line under the button).

## Copy rules

Sentence case everywhere. Verbs name outcomes: "Generate model", "Save canonical mesh", "Accept rig", "Lock look", "Export selected" — never "Submit"/"OK". Warnings are advisory and specific ("Left hand close to hip — weld risk. Generate anyway, or upload a wider pose."). Costs are stated ("Changes mark 168 frames stale"). Gates are honest (license, territory, VRAM shown before download).

## Component strategy

Base UI (`@base-ui/react`, headless) supplies interaction/a11y primitives — menus, dialogs, tabs, slider, combobox, **number field with scrubbing** (px/m, frames, speed) — styled entirely by our tokens in hand-authored CSS. No styled component kits; the aesthetic is bespoke. Icons: Lucide + custom glyphs. Viewports are framework-agnostic TS classes (see `threejs-editor-viewport` skill).
