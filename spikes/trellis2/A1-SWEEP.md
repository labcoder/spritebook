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
