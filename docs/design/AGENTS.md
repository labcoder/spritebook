# Design docs — agent guidance

- `design-system.md` defines ratified tokens, intended chrome, and the non-negotiables: semantic
  light/dark token pairs, WCAG 2.1 AA, i18n from the first string, canvas wells stay dark in both
  themes, Imprint's indigo actions and semantic status colors, pixel-truth previews render
  nearest-neighbor at integer zoom.
- UI copy: sentence case; verbs name outcomes ("Generate model", "Save canonical mesh" — never
  "Submit", "OK").
- The GUI is a slim wrapper: every primary action has a CLI twin visible via copy-as-CLI. If a
  screen needs capability the CLI lacks, the capability moves to core first.
