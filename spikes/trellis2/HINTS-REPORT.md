# Do hints repair the torn bands? Where the hint is real, yes

**Date:** 2026-07-29 · RTX 3090 · bulma r1 (154,089 verts), UniRig, seam-rule deform check

The question: the trustworthy gate says spine_02 / neck_01 / clavicle_r are genuinely torn — can
`rig --rerun-with-hints` converge to a cleaner skin, by the same seam numbers?

## The mechanism, honestly

UniRig's AR skeleton stage cannot be conditioned; the adapter says so in its own docstring. What
`--rerun-with-hints` actually does: reads the previous `rig.json`, applies your `--edits` deltas,
and hands the edited joints' ABSOLUTE positions to the adapter, which relocates them in the skeleton
npz **before the skin stage solves against it**. So hints can only repair tearing that is caused by
joint PLACEMENT. That constraint predicted the result.

## Hint derivation: joint → the centroid of the flesh it drives

`hint_from_report.py` computes, per flagged joint, the centroid of the vertices it influences above
the weight floor, and emits the delta as an `--edits` patch. On bulma:

| joint      | influence verts | \|delta\| to centroid |
| ---------- | --------------- | --------------------- |
| spine_02   | 21,380          | 21 mm                 |
| neck_01    | 24,653          | 42 mm                 |
| clavicle_r | 7,639           | **169 mm**            |

Already informative: spine and neck sit almost exactly where their flesh is; the clavicle is far
medial of the shoulder mass it drives.

## The measurement

One plain reroll (B1) establishes the noise floor; one hinted run (H1). Same mesh, same seed, same
check. Bands show `stretchedEdges/influencedEdges` (flag fires at ≥1% with ≥2 edges).

| run                   | flags | spine_02             | neck_01              | clavicle_r            |
| --------------------- | ----- | -------------------- | -------------------- | --------------------- |
| before (accepted rig) | 8     | 694/47,585 · 1.46% ✱ | 627/55,311 · 1.13% ✱ | 283/16,642 · 1.70% ✱  |
| B1 plain reroll       | 8     | 715/47,604 · 1.50% ✱ | 623/55,265 · 1.13% ✱ | 302/16,610 · 1.82% ✱  |
| **H1 hinted**         | 7     | 623/46,688 · 1.33% ✱ | 519/55,166 · 0.94%   | **55/20,720 · 0.27%** |

Reroll noise is ±0.1 pp. Against that:

- **clavicle_r: 1.70% → 0.27%, a 6× cut, far outside noise.** The 169 mm relocation also grew its
  influence set (7.6k → wider shoulder coverage at the edge level), and the skin solved against the
  corrected position stopped tearing. The one big hint produced the one big repair.
- **neck_01: 1.13% → 0.94%** — real movement (10× the noise), now just under the line. Borderline,
  honestly: a rounding of the threshold, not a cure.
- **spine_02: 1.46% → 1.33%, still flagged.** A 21 mm nudge to a joint already sitting on its
  centroid changes little — as the mechanism predicts, because its tearing is not a placement
  problem.

## Verdict

**Hints move exactly what they can move.** Placement-driven tearing (clavicle_r) repairs decisively;
tearing at a well-placed joint (spine_02) does not, and no placement hint will fix it — that
residual band needs weight-level tooling (nothing edits weights today) or a different skinning
backend. That half is the roadmap conversation, now with a measured boundary around it: one of three
bands was placement, one was borderline, one was not.

Candidate product feature, recorded not built: the centroid derivation is automatic end to end —
`deform-report.json` → `hints-patch.json` → `--rerun-with-hints` — and on this evidence it is worth
surfacing as a single verb once a second character confirms it.

## Cross-subject: the pattern holds, and shows its limit

Same protocol on the two other rigged subjects — before / plain reroll / hinted, aggregate torn
fraction over all influenced edges. Both are far worse than bulma (30–80% per-joint fractions, max
stretches 15–45×): non-humanoid geometry — a mermaid tail with jellyfish, a robot with DETACHED
floating hands — that UniRig has no skeleton for.

| subject         | before | reroll | hinted    | hint offsets          |
| --------------- | ------ | ------ | --------- | --------------------- |
| painted-mermaid | 12.69% | 12.67% | **4.89%** | 44 joints, 330–660 mm |
| robot-astro     | 18.50% | 18.50% | 15.01%    | 24 joints, 410–580 mm |

Reroll noise on the aggregate is ~0.02 pp, so both movements are real — and they complete the
pattern from bulma:

- **Big offsets repair.** The mermaid's wholesale mis-placement (median 513 mm) cut 2.6× in one
  hinted pass.
- **Topology the skeleton cannot express does not.** Astro's offsets were just as large, but no
  joint placement makes a humanoid skeleton drive detached hands cleanly; 18.5% → 15.0% is the
  honest ceiling, and the numbers say so without anyone having to render it.

## The verb: `rig --auto-hints`

The loop above is now one flag: read the previous run's own deform report, derive the centroid
edits, warn — with millimetres — for every flagged joint that has no placement offset to exploit
("that residual is a limit of the skinning backend, not something more hinting will fix"), refuse
outright when NO joint has one, and re-run with the rest as hints. Constants argued from this data:
50 mm floor between the measured no-repair (21 mm) and repair (169 mm+) populations.

Live on the mermaid it reproduces the manual experiment: **4.85%** against the manual 4.89%.

## A misparse that nearly became a finding

Mid-investigation, a quick probe "discovered" weight sums of −1.73..+3.42 and body-wide influence
smears — which would have indicted the merge stage. Both were artifacts of reading an INTERLEAVED
glb (byteStride 52) with a contiguous reader; the corrupted file it produced is what exposed the
error. Stride-aware, the sums are exactly 1.0 everywhere. The earlier `deform_dist.py` numbers stand
(its reader handles stride, which is why it matched the shipped report to 4 decimals).
`rig-run.json`'s `unnormalizedVertices: 111174` describes pre-merge interpolation drift that the
merge then normalizes — a misleading name for a healthy diagnostic, not a defect.

## Follow-up: the split is a seed outcome, not a subject property

The astro ceiling above was blamed on the subject — "this robot's hands come off". That framing was
too strong. Re-generating the SAME image at other seeds:

| workspace        | gen seed | shells | body-sized | top fractions        |
| ---------------- | -------- | ------ | ---------- | -------------------- |
| robot-astro/r1   | 7        | 76     | **2**      | 60.4% / 20.0% / 4.6% |
| astro-100/r1     | 100      | 81     | 1          | 78.9% / 2.9% / 2.7%  |
| astro-200/r1     | 201      | 54     | 1          | 89.8% / 1.1% / 0.8%  |
| bulma (verb-e2e) | 7        | 72     | 1          | 92.5% / 1.6% / 1.6%  |
| bulma-100/r1     | 100      | 66     | 1          | 91.7% / 1.7% / 1.3%  |

Two of two re-rolls fused astro into one body. So the detached hands were a property of that
generation, not of the artwork, and the remedy is cheaper than any repair tooling: re-run `gen` and
take the connected result. That is now recorded per result (`output.bodies`) and surfaced by both
`gen` and `pick`.

### What the existing workspaces could NOT answer

The first attempt at this question surveyed bulma's r1–r5 and the cross-subject workspaces and found
byte-identical shell distributions inside every one of them. That is not seed stability — every r2+
in those workspaces is a `retexture`, which by definition keeps its parent's geometry (`derivedFrom`
says so on each receipt). Each workspace held exactly ONE generated mesh, so the sample size for
"does the seed change the shell count" was 1 per subject until the runs above.

Separately: two `gen` runs of bulma at the same seed 7 produced 72 and 73 shells. The pipeline is
not bit-reproducible across processes on this GPU; both were 1 body, so the significant count was
stable where the raw count was not — which is the reason the flag counts only body-sized shells.
