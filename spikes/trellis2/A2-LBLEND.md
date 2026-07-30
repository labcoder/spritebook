# A2 follow-up: how much of the L compensation to apply

**Status: RUBRIC — committed before any rendering.** The first A2 A/B showed the defect: full L
compensation lifts mean L ~28%, and a big Oklab L lift runs saturated regions into the sRGB gamut
ceiling, where clamping DESATURATES — bulma's pink top and princess's blush dress bleached toward
white. The a/b transfer is sound (mermaid: hueDist 0.0237 → 0.0017, no visible harm); this rubric
tunes only the L term.

## The knob

`lBlend` (λ): the L target becomes `lerp(textureMeanL, sourceL / cbrt(meanShade), λ)`, and the L
spread target scales the same way. So:

- **λ = 0.0** — L untouched: pure hue/chroma transfer.
- **λ = 1.0** — the current behaviour: full shade-compensated match.
- 0.5 / 0.75 between.

## Grid — pre-registered

λ ∈ {0.0, 0.5, 0.75, 1.0} × the three subjects (bulma r2 at the new gen defaults, mermaid r1,
princess r1), inputs = each subject's UNMATCHED canonical mesh + its stored source. 12 runs, pure
CPU, then 12 front-view bakes for the renders.

## Metrics

1. **hueDistAfter** (as A2 reports it).
2. **gamutClipFraction** (NEW): the fraction of painted texels whose matched Oklab value falls
   outside the sRGB gamut before clamping (any linear channel < −0.001 or > 1.001). This is the
   number the washout hides behind — a clipped texel silently loses chroma.
3. **lAfter** vs the subject's own render context (for the record).
4. The renders, all three subjects, against their references.

## Decision rule — pre-registered

1. Eligible: λ cells with `gamutClipFraction ≤ 0.05` on EVERY subject.
2. Among eligible: minimise mean `hueDistAfter`; ties within 0.003 go to LOWER λ.
3. The renders decide between rule-2's winner and its neighbours; the maintainer delegated this pick
   to the renders, and whatever is chosen — including an override of rule 2 — is recorded here with
   the reason.
4. The chosen λ becomes `colormatch.ts`'s default; the guard-rail tests move with it.

## Results (2026-07-30, 12/12 runs)

| subject  | lambda | hueAfter | L after (target) | gamut clip % |
| -------- | ------ | -------- | ---------------- | ------------ |
| bulma    | 0.00   | 0.0057   | 0.545 (0.542)    | 32.5         |
| bulma    | 0.50   | 0.0133   | 0.707 (0.725)    | 39.5         |
| bulma    | 0.75   | 0.0228   | 0.775 (0.816)    | 43.6         |
| bulma    | 1.00   | 0.0313   | 0.837 (0.907)    | 50.6         |
| mermaid  | 0.00   | 0.0006   | 0.496            | 4.8          |
| mermaid  | 0.50   | 0.0009   | 0.546            | 3.8          |
| mermaid  | 0.75   | 0.0013   | 0.571            | 6.0          |
| mermaid  | 1.00   | 0.0017   | 0.596            | 9.0          |
| princess | 0.00   | 0.0001   | 0.548            | 1.2          |
| princess | 0.50   | 0.0006   | 0.696            | 5.0          |
| princess | 0.75   | 0.0049   | 0.764            | 23.1         |
| princess | 1.00   | 0.0127   | 0.825            | 49.8         |

**The registered rule failed closed, and taught something doing it:** no cell clears the 5% clip bar
on EVERY subject, because bulma clips >= 32.5% even at lambda 0 — moving a grey-green texture onto
saturated teal/pink is an out-of-gamut operation at ANY lightness. Gamut cost from the CHROMA
transfer is a subject property; the lambda axis only owns the marginal clipping above it. Two clean
lambda signals anyway: hue accuracy DEGRADES monotonically with lambda (clamped texels shift hue),
and princess's clip curve (1.2 -> 5.0 -> 23.1 -> 49.8) is the measured face of the pastel bleach.

**Decision (renders, as rule 3 provides; recorded):** **lambda = 0.5.** By eye: bulma recovers
brightness with the pink top intact; princess brightens WITHOUT the white patches that appear from
0.75 up; mermaid is indifferent across the row. lambda 0 wins the hue metric but leaves the measured
darkness (bulma L 0.545) unfixed, which is the reason the L term exists. 0.5 buys most of the
brightness for the least clipping growth. `L_BLEND = 0.5` is the shipped default; the guard-rail
tests derive their expectations from it.
