# Studio visual identity studies

**Status: rejected first round, 20 October 2026.** The maintainer rejected all three directions. See
the [second round](round-2/README.md) for the current exploration, informed by their Nous Research
and Honcho references. This page and its demo remain historical evidence. No production application
source, core behavior or ratified design tokens changed. Nothing was pushed.

Open [index.html](index.html) in a browser. It works directly from disk, including fonts and
sprites. Choose A/B/C, switch the shell theme, or inspect at 100%. Frame selection, playback, eight
directions and sample controls work locally. Recording a look opens an explanation; it never calls
the CLI or desktop bridge.

## The choices

| Direction      | Visual language                                                 | Typography and geometry                                                 | Main tradeoff                                                                |
| -------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **A · Slate**  | Warm graphite, apricot actions, quiet surface layers            | Plex Sans throughout; restrained mono; soft rectangular controls        | Familiar creative-tool identity; needs consistent detail to feel distinctive |
| **B · Paper**  | Cool pale surfaces, blue ink, dark sprite canvas                | Chakra headings; Plex controls; square corners and explicit panel rules | Strong light identity; dense screens can accumulate too many boundaries      |
| **C · Signal** | Saturated midnight blue, yellow actions, small stage-color cues | Compact Chakra headings; flat surfaces; tighter, angular geometry       | More recognizable personality; shell color can compete with artwork          |

The common layout, tiny annotations and limited variation between directions did not give the
maintainer a convincing visual identity. None is recommended for implementation.

All three have light/dark shell variants and permanently dark canvas wells. The comparison keeps
composition and content consistent: these are identity options, not three proposed navigation
systems. The shared Look composition is illustrative; choosing an identity does not approve every
layout or interaction shown here.

## Evidence and reuse

- The eight PNG strips preserve the image payload of the completed Pixal3D Windows qualification's
  `pixal-walk-loop-d00..07-strip.png`, bake `acc25412`, recorded `2026-10-20T04:37:39.792Z`. Each is
  600 × 128 pixels: six 100 × 128 frames. The original evidence is preserved under
  `.render-bench/cleanup-temp/evidence/`. Round two added origin metadata to these shared PNGs;
  their pixel-bearing chunks remain byte-identical.
- The UI crops transparent cell padding for presentation; it does not change the source PNGs.
  Sprites use nearest-neighbor sampling at 2×/4× inside the desktop composition. The fit-to-page
  overview scales the entire composition; use 100% to inspect pixels. No new model inference or
  render was performed.
- `Juniper` is an illustrative display name. The real evidence character ID is `pixal`. The saved
  bake contains 144 frames across three clips and eight directions. Sample settings do not produce
  new preview pixels.
- Fonts are copies of the existing Studio assets: IBM Plex Sans, IBM Plex Mono and Chakra Petch,
  under SIL OFL 1.1, already listed in [the dependency inventory](../../docs/dependencies.md). No
  new font or UI package was added to the application. Their notices are included in
  [OFL-Plex.txt](assets/OFL-Plex.txt) and [OFL-Chakra.txt](assets/OFL-Chakra.txt). SVG marks and
  icons are simple authored geometry.

## Impeccable

[Impeccable](https://impeccable.style) 4.7.0 was installed as a user-level Codex skill at
`C:/Users/oms10/.codex/skills/impeccable`, from the official
[`pbakaus/impeccable`](https://github.com/pbakaus/impeccable) repository, pinned to
`dad8dbb3aac21ad1fa236c110315ef4abece23e8` (Apache-2.0). Its native engine loaded project context.
No repository hooks or application dependency were installed.

The studies use its Operate guidance, new-work exploration and craft floor: familiar controls,
legible hierarchy, meaningful color, restrained motion and rendered review. The direction exercise
(`seed:38c98449ec7a3a28`) challenged the default with catalog, notation, ticket, record-sleeve and
transit systems. Their useful disciplines were thumbnail legibility, explicit states and clear stage
wayfinding; literal paper decoration, coded labels and unfamiliar navigation were rejected for a
working editor. The decision remains with the maintainer.

## After a direction is selected

1. Confirm its light/dark palettes, typography, wordmark treatment, control shape and density, then
   update the canonical design-system document and decision log.
2. Apply the approved identity to the existing Tauri/React shell and Base UI components. Keep
   TypeScript behavior, manifests, CLI twins, undo and core-produced pixels authoritative. Do not
   introduce a replacement component framework.
3. Review the real character editor, gallery, model manager, errors and busy states. Treat layout
   changes and additional preview interactions as explicit follow-up scope. Verify keyboard access,
   contrast, localization expansion and Windows UI behavior before calling the implementation
   complete.

No implementation milestone is marked complete by these studies. F7 qualification and the existing
F5 editor roadmap remain unchanged while the identity is undecided.
