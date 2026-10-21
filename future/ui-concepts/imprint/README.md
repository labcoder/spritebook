# Imprint polish: paired light and dark studies

**Status: Imprint is the selected working direction; this refinement awaits visual review.** Open
[review.html](review.html) for the comparison, or serve [index.html](index.html) for the 1440 × 900
editor sketch with its working Theme selector. The remaining editor controls are illustrative and do
not call SpriteBook.

This uses Impeccable 4.7.0's polish workflow and preserves Imprint's condensed type, monospaced
controls, open comparison, six stages and real saved sprite output. Production application source
and ratified design tokens remain unchanged. Do not push.

## The requested changes

1. Removed the ASCII torus and the isolated header hatch stamp. The current study contains no
   animated or replacement mascot. Round two retains its historical alternatives.
2. Shifted the saturated `#2634DA` blue to deeper, less saturated indigo `#2D3D88`. A fine authored
   crosshatch covers the light workspace background; fields and title chrome have solid surfaces.
   Dark uses sparse ordered dither over a blue-gray ground.
3. Reduced the wordmark from 82px to 36px and the title bar from 100px to 56px. The recovered space
   expands the comparison wells. The stage heading also steps down from 64px to 44px.
4. Designed dark-mode roles individually: pale indigo actions, muted blue selection fills, raised
   fields, lighter text and a separate texture. There is no inversion filter. The reference and
   sprite wells retain the same colors and image treatment in both themes.

## Study palette

These are draft tokens in the sketch, not a production design-system amendment.

| Role            | Light                      | Dark                       |
| --------------- | -------------------------- | -------------------------- |
| Workspace       | `#F1F0E9` + crosshatch     | `#1B2130` + sparse dither  |
| Title chrome    | `#EEEFEA`                  | `#202839`                  |
| Fields          | `#F8F7F2`                  | `#252E40`                  |
| Primary text    | `#303A66`                  | `#E1E6F0`                  |
| Secondary text  | `#535E7C`                  | `#A6B1C8`                  |
| Brand / accent  | `#2D3D88`                  | `#B7C6FA`                  |
| Primary action  | `#2D3D88` / `#FAFAF5` text | `#A9BEFF` / `#18223F` text |
| Current stage   | `#2D3D88` / `#FAFAF5` text | `#2B3E6B` / `#DEE7FF` text |
| Field border    | `#7A86A9`                  | `#6C7B9A`                  |
| Focus           | `#354BA8`                  | `#C4D2FF`                  |
| Preview checker | `#171E28` / `#1C232D`      | Same                       |

Barlow Condensed and Geist Mono reuse the existing study files, source pins and OFL notices in
[round-2/assets](../round-2/assets/font-sources.json). The two texture SVGs are original, static
geometry with source metadata. No dependencies, installed fonts or model assets were added.

## Verification and limits

- Inspected the actual light and dark browser captures at 1440 × 900, after fonts loaded. No missing
  image/font assets, body overflow or text below 12px was found.
- Theme switching works through the native select and keyboard, with a visible 2px focus outline.
  There are no animations, network services or production mutations in the sketch.
- Default text contrast and sampled hover states pass 4.5:1; large text passes 3:1. Secondary text
  against the modeled darkest overlap of the light crosshatch is 4.64:1. The dark field border was
  strengthened to 3.20:1 against its field surface.
- The captured saved-output well is byte-identical between light and dark themes. Source PNGs, 6×
  nearest-neighbor crops, camera angles and character asymmetry are unchanged. This is existing
  Pixal3D evidence for character `pixal`, bake `acc25412`, not a new render.
- The one Impeccable detector pass flagged the edge-to-edge preview well's padding. The media area
  intentionally fills that well; all controls and captions have their own insets. No suppressions,
  hook installation or clean-detector claim was added.
- Screenshots in `review/` carry embedded origin metadata. The review viewer is a scaled overview
  with native-size inspection; it does not qualify app resizing or mobile layouts.
- The standalone/inlined viewer switches both themes, restores native 1440px inspection, and fits
  728px and 390px review widths without horizontal page overflow. No new permanent test suite was
  added for these reversible visual studies.

Raw-file editor launch was not verified: the automation CLI blocks launching `file:` URLs. The
editor was verified through a loopback static server; the self-contained viewer was also verified
without that server.

This is a focused visual polish pass, not a full accessibility audit or native desktop
qualification. Production light/dark application, localization expansion, busy/error states and
platform behavior remain part of the later approved implementation. No roadmap gate closes.
