# A3: reproject composed with colour-match

**Date:** 2026-07-30 · three subjects, `pick --reproject` (colour-match default-on at λ 0.5 ran
first, reprojection after — the amended ordering, so exact source-painted texels are never shifted
by the transfer).

## Measurements

| subject  | colour-match hue → | reproject painted | low-coverage warn | back-view damage |
| -------- | ------------------ | ----------------- | ----------------- | ---------------- |
| bulma    | 0.0377 → 0.0133    | 10.4% of texels   | none              | none visible     |
| mermaid  | 0.0237 → 0.0009    | 11.8%             | none              | none visible     |
| princess | 0.0052 → 0.0006    | 10.9%             | none              | none visible     |

~10–12% of texture texels is the front-visible surface, which is exactly what the projection can
prove it sees; the rest keeps the (colour-matched) generated paint.

## What the renders show (`out/p3-exit/contact/a3-reproject.png`)

The single largest visible win of the whole colour thread: **the faces come back.** All three
subjects had the generated character's washed, eyeless face — the latent decoder smooths exactly the
detail a person looks at first. Reprojected, bulma has eyes and her red bow's shape, mermaid's face
and tail scales resolve, princess gets her face and the dress's gold trim. Backs are untouched (they
keep matched generated paint) with no visible seam at the silhouette boundary on any of the three.

## Recommendation

**`--reproject` should join the default for image-sourced characters**, exactly as colour-match did:
default-on with a `--no-reproject` opt-out, ordering unchanged (match → reproject), the existing
`reproject-low-coverage` warn as the guard for meshes that do not face the camera, and the
plain-copy contract reachable via `--no-color-match --no-reproject`. Evidence: face recovery on 3 of
3 subjects, zero visible back damage, no coverage warnings, ~1–2 s CPU per pick.

Held for the maintainer's confirmation (a default change on the strength of three subjects is theirs
to ratify). A4 (source-image palette) note: after match + reproject, bulma's hair reads teal in the
render — the residual that A4 was conditioned on may already be gone; re-measure before building it.

## A4 closed on this evidence (2026-07-30)

Ratified as default; re-measured on the final path (match λ0.5 + reproject, pixel-16 bake of bulma):
the palette is `#0a1622 #0a2743 #093a4e #2f3651 #226a69 #47688e ... #3f8ba7 ...` — **four teal
entries and three blue**, flicker 0.352% (budget 0.55). The "no teal in the palette" defect class
that conditioned A4 (source-image palette) no longer exists, so A4 is CLOSED WITHOUT BUILDING. Wave
A is complete: A0 ✓ A1 ✓ (3.5/0.2) A2 ✓ (λ0.5) A3 ✓ (default-on) A4 ✓ (moot).
