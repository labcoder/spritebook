# A1: the combined tier × texture-guidance × rescale sweep

**Status: RUBRIC — committed before any rendering.** Results and the decision land below the rule,
never above it. (QUALITY-AUDIT.md Wave A; the seed-42 lesson is why this section exists before the
data does.)

## What is frozen by this sweep

`operationDefaults.gen3d`: `pipelineType`, `textureGuidance`, `textureGuidanceRescale` — together,
because the 512 and 1024 tiers run DIFFERENT texture flow models, so a guidance optimum swept on one
is not portable to the other. And `operationDefaults.retexture`: `textureGuidance`,
`textureGuidanceRescale`, re-judged on the same grid (its 7.5 was chosen on saturation recovery
alone, with rescale unplumbed).

## Grid — pre-registered

- **Gen leg** (the image-to-3D pipeline, one load, both tiers through `pipeline_type`):
  - tier ∈ {`512`, `1024_cascade`} — cascade because it is upstream's own shipped default; plain
    `1024` is excluded to keep the grid affordable and because neither our evidence nor upstream's
    defaults point at it.
  - (strength, rescale) ∈ {(1.0, 0.0)} ∪ {2.0, 3.5, 7.5} × {0.0, 0.2} — 7 cells. Strength 1.0 takes
    no rescale cell: the CFG mixin short-circuits at 1.0, so rescale is unreachable there.
  - subjects: `refs/bulma-front.png` (the external reference that exposed every texture defect),
    `refs/painted-mermaid.png` (painted style, the strongest 16-colour win).
  - seeds: **7, 100, 201, 500** — 7 is the historical problem seed, 100/201 are the shell-study
    re-rolls, 500 is fresh and appears nowhere in prior evidence.
  - 2 × 7 × 2 × 4 = **112 samples**.
- **Retexture leg** (the texturing pipeline, fixed geometry = bulma-fixed's canonical mesh,
  resolution 512): the same 7 (strength, rescale) cells × the same 4 seeds = **28 samples**.
- Export settings held at production values (textureSize 2048, decimation 200 000); `lowVram` true;
  steps 12 (steps are C1's axis, not this sweep's).
- No retry ladder inside the sweep: a collapsed sample is RECORDED as collapsed and excluded from
  colour means; the rate is a judged metric, not papered over.

## Metrics — per sample, aggregated per cell as the mean over its seeds

All colour metrics in **Oklab**, computed over the exported glb's baseColor texture texels with
`sum(rgb) > 0.02` (painted texels), against the source cutout's pixels with alpha > 0.5:

1. **hueDist** (primary): `hypot(mean_a_tex − mean_a_src, mean_b_tex − mean_b_src)`.
2. **chromaDelta** (signed): `mean_C_tex − mean_C_src`, where C = hypot(a, b). Positive =
   oversaturated — the failure fal warns about.
3. **satDelta**: HSV saturation mean delta, for comparability with GUIDANCE-REPORT.md.
4. **lDelta** (signed): `mean_L_tex − mean_L_src` — texture-space, pre-lighting, so it is the
   texture's own darkness and not the rig's.
5. **collapseRate**: fraction of the cell's samples the two-sided detector rejects.
6. **metalMean**: mean metallic fraction (the chrome failure mode must not regress).
7. **bodies**: significant connected shells of each exported glb (computed post-sweep with the
   importer's own `componentsOfFile`) — the tier axis's shape signal.
8. **wallSeconds** per sample, because the tier decision buys time with quality.

## Decision rule — pre-registered

1. **Eligibility:** a cell is eligible if `collapseRate ≤ 1/8` of its samples (baseline: ~5% per
   seed at 512/1.0) AND `metalMean` ≤ baseline cell's + 0.05.
2. **Guidance (per tier):** among eligible cells, minimise mean `hueDist` across both subjects. Ties
   within 0.005 go to LOWER strength, then LOWER rescale (gentler wins ties).
3. **Tier:** `1024_cascade` replaces `512` only if its best cell beats 512's best `hueDist` by ≥ 20%
   **or** clearly improves shape (fewer multi-body results across its 16 gens per subject, or a
   visible hands/fingers improvement in the renders) — otherwise 512 stays and the extra wall-time
   is not paid.
4. **Retexture:** rule 2 applied to the retexture leg's own cells.
5. **Escape hatch:** if every guided cell oversaturates (`chromaDelta > +0.06`) or loses to the 1.0
   control on `hueDist`, the control stays and the sweep reports that guidance does not pay on this
   model — a null is a result.
6. The maintainer picks from renders; this rule is the RECOMMENDATION's derivation, and any override
   is recorded next to it.

## Outputs

`out/a1-sweep/sweep.jsonl` (one row per sample, resumable), per-sample `basecolor.png` + `mesh.glb`,
contact sheets built from front-view bakes after the sweep, and the results + recommendation
appended BELOW this line only after the grid is complete.

---

# Results (2026-07-30, 140/140 samples, 0 errors)

## The registered rule's own verdict, mechanically applied

- **Rule 1 failed closed on 3 of 5 legs.** Every bulma cell on both tiers and every retexture cell
  is ineligible — the metal criterion excluded the SUBJECT, not bad cells, because bulma's metal
  misclassification is image-driven (the crossover result) and afflicts the baselines too. Nothing
  on those legs could be compared.
- **Rule 2, judged on the one eligible subject (mermaid):** the 0.005 tie band swallows every
  guidance effect on both tiers, so the tie-breaker elects the CONTROL (g1.0/r0.0) twice.
- **Rule 3:** cascade's best eligible hueDist (0.0170) beats 512's (0.0305) by 44% ≥ the 20% bar.
- **Mechanical outcome: gen3d = `1024_cascade` @ 1.0/0.0; retexture = no verdict.** This
  recommendation is REJECTED below, with reasons in the open — the rule's eligibility criterion
  silenced exactly the evidence (bulma) where cascade fails hardest, and its tie band was set wider
  than the real effect sizes. Both are rubric-design errors, recorded so the next rubric fixes them.

## What the data and the renders actually show

Per-cell means (4 seeds each; full table in `out/a1-sweep/sweep.jsonl`):

| leg/tier/subject    | best cell (hueDist)          | control (1.0) | dC at best         | metal         | note                                        |
| ------------------- | ---------------------------- | ------------- | ------------------ | ------------- | ------------------------------------------- |
| gen 512 bulma       | 2.0/0.2 and 3.5/0.2 (0.0254) | 0.0285        | −0.005 / +0.004    | ~0.48 flat    | s500 is a bad SEED at every cell            |
| gen 512 mermaid     | 3.5/0.2 (0.0305)             | 0.0331        | +0.025             | 0.12–0.14     | jellyfish/accents visibly truer when guided |
| gen cascade bulma   | 7.5/0.2 (0.0150)             | 0.0236        | **−0.019..−0.041** | **0.93–0.97** | renders visibly darker; s7 near-black       |
| gen cascade mermaid | 7.5/0.2 (0.0170)             | 0.0206        | +0.003..+0.015     | 0.19–0.25     | hair hue closer; jellies washed out         |
| retexture 512 bulma | 3.5/0.2 (0.0203)             | 0.0231        | −0.002             | ~0.75 flat    | renders invalid (see below)                 |

Findings that outrank any single number:

1. **The hueDist metric can be flattered by desaturation, and cascade-bulma is the proof:** its
   hueDist improves to 0.0150 while `chromaDelta` goes NEGATIVE (−0.035: less chroma than source)
   and the renders go visibly dark and muddy. A global mean a/b drifts toward neutral as chroma
   collapses. hueDist must be read WITH chromaDelta; the next rubric should use a chroma-weighted or
   per-region hue metric.
2. **Guidance visibly helps at 512.** On bulma, the control's s7 loses the red bow and washes the
   top; every guided cell restores teal hair, pink top, red bow on seeds 7/100/201. On mermaid,
   guided cells saturate the jellyfish and bikini toward the reference. The numbers (0.0285→0.0254,
   0.0331→0.0305) undersell what the renders show, which is the tie-band lesson.
3. **No oversaturation anywhere** — max dC +0.037 (512-mermaid @7.5/0.0), under the +0.06 bar. The
   fal warning did not materialise at these strengths on these subjects.
4. **Zero black/white texture collapses in 140 samples.** The two-sided detector never fired; every
   "collapse" was the METAL gate. The ~5%/seed black-collapse rate from the original spike did not
   reproduce at these settings.
5. **Metal is a seed-and-subject phenomenon, and cascade makes it worse:** bulma-512 flags 2/4 seeds
   (s201, s500; s201 recovers at 7.5), bulma-cascade 4/4 at every cell, mermaid 0/4 at 512. Metal
   does not touch the sprite renderer (baseColor only) but poisons PBR export.
6. **s500 is simply a bad seed for bulma at 512** — near-black at every guidance level. No sampler
   setting rescues a bad seed; `gen --candidates` (B2) is the designed answer.
7. **Bodies: 112/112 single-body** across both tiers — the tier axis shows no shape signal here.
8. Cost: cascade is 1.8× (bulma, ~57 s) to 3.7× (mermaid, ~185 s) slower than 512.

**Retexture render caveat:** the retexture leg's contact renders were built by swapping each
sample's baked atlas into the canonical glb — but the texturing pipeline bakes its OWN UV atlas,
which does not match the canonical layout, so those renders are mottled garbage and are excluded as
evidence. The colour metrics are computed on the textures themselves and stand. Visual confirmation
of the retexture cells rides on the real verb (which exports correctly) in A3's measurements.

## Recommendation (post-hoc, deviating from the registered rule as documented above)

- **gen3d: `pipelineType` stays `512`; `textureGuidance` 3.5, `textureGuidanceRescale` 0.2.**
  Cascade is rejected despite its hueDist win: the win is partly a desaturation artifact (finding
  1), its bulma renders are worse to the eye, it doubles-to-quadruples wall time, and it drives
  bulma's metal to 4/4 seeds. 3.5/0.2 is the best 512 cell on mermaid, tied-best on bulma, dC
  centred on zero, and inside the deployment band. The conservative alternative is 2.0/0.2
  (identical bulma hue, −0.001 mermaid, matches Scenario's shipped 2).
- **retexture: `textureGuidance` 3.5 (down from 7.5), `textureGuidanceRescale` 0.2** — best hue of
  its leg (0.0203 vs 7.5/0.0's 0.0232), chroma dead-neutral (−0.002), on numbers alone pending A3's
  rendered confirmation.
- `1024_cascade` stays available as a quality option; a future `--quality` detent or candidates tier
  can spend it deliberately. Nothing moves in the catalog until the maintainer picks from the sheets
  (`out/a1-sweep/sheets/`).

## The pick (rule 6)

2026-07-30: the maintainer took **3.5/0.2 for both gen3d and retexture**, from the contact sheets —
matching the post-hoc recommendation, no override. Frozen in the catalog; the capabilities test pins
both operations' defaults.
