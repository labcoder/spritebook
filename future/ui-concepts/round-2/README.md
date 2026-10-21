# Studio identity exploration, second round

**Status: Imprint selected as the working direction.** The
[paired light/dark polish](../imprint/README.md) is the current review; these are the original
second-round alternatives. Open [index.html](index.html) directly in a browser. It compares the
captured 1440 × 900 screens, includes original ASCII motion and offers a 100% inspection view. Its
temporary decision board was used during selection; use the paired Imprint review for current
feedback.

| Direction                      | Source sketch                      | Identity and tradeoff                                                                                                                                        |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Imprint — recommended next** | [route.html](route.html)           | Chalk, cobalt, compressed Barlow Condensed and thin rules. Closest to Nous; the large wordmark may need a quieter compact variant for long sessions.         |
| **Phosphor**                   | [color-room.html](color-room.html) | Warm dark, Silkscreen lettering, pale green and a continuous exposure strip. Closest to Honcho; the retro emphasis could imply a pixel-only product.         |
| **Etch**                       | [proof.html](proof.html)           | EB Garamond, copper, crosshatching and an eight-direction proof board. Calmest hierarchy; furthest from the requested compressed and bitmap type references. |

The sketches are static HTML/CSS. Native fields can receive focus, but their values and buttons do
not run SpriteBook. Only the comparison viewer's selection, inspection and motion replay controls
are interactive. Selecting an identity does not approve every illustrated layout, setting or
interaction.

## The revised brief

The maintainer explicitly likes [Nous Research](https://nousresearch.com/)'s typography and style
and [Honcho](https://honcho.dev/)'s art direction, including animated ASCII, dithering and
crosshatching. Both sites were inspected as rendered 1440 × 900 pages on 20 October 2026 Pacific.
Nous's compressed display/body contrast and Honcho's bitmap/dashed language informed the studies.
Their logos, illustrations and proprietary font files were not copied.

Impeccable **4.7.0**, released
[19 October 2026](https://github.com/pbakaus/impeccable/releases/tag/cli-v4.7.0), matches the
installed skill. Its native engine is **0.1.16**. Codex CLI **0.163.0** matches the
[15 October stable release](https://github.com/openai/codex/releases/tag/rust-v0.163.0). A fresh
Codex discovery check returned the skill enabled with no parsing errors.

The work used Impeccable's Operate/new-work flow, its concept seed `seed:38c98449ec7a3a28` (second
hand), parallel HTML sketches and rendered review. The original wayfinding, contact-sheet and
type-specimen structures were translated to the maintainer's subsequently supplied visual
references. The updated brief takes precedence over the seed's materials. No application design
system is ratified by these alternatives.

## Assets and verification

- The supplied `reference.png` is the original illustration used in the existing F4 proof. It is
  labeled as reference art, not a generated model. Source ownership and application behavior are
  unchanged; this is a private, local study.
- Saved sprite strips are the existing Pixal3D character `pixal`, bake `acc25412`, recorded
  `2026-10-20T04:37:39.792Z`: three clips, eight directions, 144 frames. The studies use actual PNG
  crops at 2×, 4× or 6× nearest-neighbor zoom. No new inference, texture processing, dither pass or
  render was performed. Overview screenshots scale the whole screen; use 100% to inspect pixels.
- Impeccable origin metadata was added to the reference, shared strips and browser captures. The
  nine source images' pixel-bearing PNG chunks were checked before and after and remain
  byte-identical. The provenance scan reports no missing origins across twelve rasters.
- The ASCII torus is original procedural vector art. Its [source](assets/ascii-orbit.py) regenerates
  twelve distinct projections and three colorways with standard Python. Motion runs once for 4.5
  seconds; reduced motion swaps in a separate still SVG. Browser readback confirmed replay changes
  the art, playback stops, and the reduced-motion view remains still. Hatching stays in
  brand/selection surfaces; no pattern or filter is applied to sprite pixels.
- New WOFF2 files are design-study assets only. Exact URLs, hashes and complete SIL OFL notices live
  in [assets/](assets/font-sources.json), with a row in the
  [dependency inventory](../../../docs/dependencies.md). No UI package was added; no fonts were
  installed into Windows or bundled by Studio.
- All three screens were captured in Edge at 1440 × 900 after fonts loaded. Checks found no missing
  image/font assets, body overflow or text below 12px (Phosphor's minimum is 13px). Computed default
  text contrast passed the sampled solid-background checks. Impeccable detected a Phosphor hover
  contrast of 4.4:1; its hover surface was darkened. This is not a full accessibility audit.
- Impeccable's one detector pass also flagged common Geist type, chalk/cream surfaces, hatching and
  flush media containers. These remain deliberate choices: identity comes from the three display
  faces; paper and hatch follow the brief; text has its own inset inside edge-to-edge image boards.
  No detector suppressions or project hook were installed, and no clean detector verdict is claimed.
- Independent concept review found materially distinct identities and no additional visible clipping
  or provenance defect. It recommended exploring Imprint next, with the wordmark's dominance as an
  explicit tradeoff. This verdict covers the selection sketches, not a production implementation.
- The self-contained viewer passed checks for switching all three concepts, 1440px inspection,
  inlined assets and motion replay. Its layout was checked at 728px/light and 390px/dark without
  horizontal page overflow. These are review viewer widths, not mobile-app or dark-mode
  qualifications of the app designs.

No application source, ratified tokens, manifests, model installs or Rust builds changed. No CI or
native desktop qualification ran. The next step is the maintainer's visual choice, followed by an
agreed implementation scope and a real light/dark, keyboard, localization and Windows review. F5/F7
gates remain open.

## Exploration notes

Unapproved visual studies. The maintainer rejected Slate, Paper and Signal and wants a substantially
stronger visual identity before any application changes. Keep all work local. Do not push or modify
the production UI or its ratified tokens.

SpriteBook turns a character reference into reusable, animated 2D game sprites. The intended
audience is a solo or small-team game developer working for hours in an editor. The screen must look
like an authored creative tool: legible at normal desktop size, generous to the artwork, and precise
about the six-stage workflow.

The first round's common template, tiny annotations, nested panels and palette-only variation are
anti-references. New candidates must differ at thumbnail size through composition, typography,
spacing and component shape as well as color. The actual product capabilities, dark preview wells
and honest preview provenance remain fixed.

## Grounded starting points

Ordered before Impeccable's direction exercise:

1. **Animation color-key boards.** Artwork and ordered sequences lead; warm white, deep ink and a
   controlled vermilion selection; humanist type and broad working margins. Signature: the same
   character is read across its direction sequence.
2. **Photographic contact sheets.** A dense, matte charcoal field, white labels and orange-red
   selection; narrow grotesk type and exact alignment. Signature: the selected exposure is anchored
   to a continuous strip of saved frames.
3. **Independent game manuals.** A friendly green and chalk identity, clear rounded grotesk type and
   flat surfaces. Signature: a strong character index connects the roster to the currently edited
   character without turning everything into cards.
4. **Public wayfinding typography.** A white and ink system with functional blue and ochre,
   consistently sized labels and generous hit areas. Signature: the current stage is unmistakable
   even when all color is removed.
5. **Museum photographic accession systems.** Neutral white, black and a small red selection; sober
   grotesk typography and calm, open settings. Signature: reference and saved output have separate,
   clearly named visual territories.
6. **Animation exposure notation.** Pale gray and black with sparse cyan state, tabular timing and
   compact controls. Signature: clip, direction and frame are readable together through a deliberate
   temporal scale.
7. **Independent record catalog identities.** Strong typographic hierarchy, cobalt and white fields
   and small yellow actions. Signature: names and thumbnail images form a recognizable catalog
   rhythm across editor and roster surfaces.

The maintainer subsequently selected Imprint. The original three-panel fallback remains historical;
no direction tournament or selection watcher is needed for the focused polish pass.
