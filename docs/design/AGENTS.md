# Design docs — agent guidance

- `design-system.md` defines tokens (provisional), chrome, and the non-negotiables: semantic
  light/dark token pairs, WCAG 2.1 AA, i18n from the first string, canvas wells stay dark in both
  themes, acid hues are fills never text-on-light, pixel-truth previews render nearest-neighbor at
  integer zoom.
- UI copy: sentence case; verbs name outcomes ("Generate model", "Save canonical mesh" — never
  "Submit", "OK").
- The GUI is a slim wrapper: every primary action has a CLI twin visible via copy-as-CLI. If a
  screen needs capability the CLI lacks, the capability moves to core first.
