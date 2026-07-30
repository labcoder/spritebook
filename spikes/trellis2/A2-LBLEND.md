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

## Results land below this line only after the grid is complete.
