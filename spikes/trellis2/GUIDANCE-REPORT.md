# Why the texture never matched the reference

**Date:** 2026-07-28 · RTX 3090 · guidance sweep (16 runs), four subjects through the real verbs (4
generations + 10 retextures), then a 2x2 mesh-vs-image crossover (8 runs)

The complaint was "retexture doesn't look like the source, and the seed shouldn't matter this much
when you have the source image." Two suspects were ruled out with measurement, two real causes were
found, and one of them is fixed.

## Ruled out

**Colour space.** Both export paths write the same material structure with
`baseColorFactor [1,1,1,1]`. Fitting `r2 = r1^γ` on identical-camera renders gives residuals of
0.11–0.14 with per-channel exponents 0.46 / 0.27 / 0.26 — a transfer-function bug needs one exponent
and a near-zero residual. Neither sRGB→linear nor linear→sRGB recovers the missing saturation.

**Background removal.** The cut-out is 99% binary: 16.3% fully opaque, 82.7% fully clear, 0.98% soft
edge. `preprocess_image` premultiplies against black and drops alpha, which on that mask moves the
foreground mean by **0.001** and saturation by **0.0007**. The gated BiRefNet is never constructed.

## Cause 1: the texture stage runs with guidance switched off

The source pixels never touch the mesh. The chain is crop → premultiply → **resize to 512²** →
DINOv3 → one embedding → a flow-matching sampler starting **from noise** → texture latent → decode.
There is no reprojection anywhere; the image constrains the texture the way a caption does.

And it barely constrains it, because of this — identical in `pipeline.json` and
`texturing_pipeline.json`:

| stage            | guidance_strength | rescale |
| ---------------- | ----------------- | ------- |
| sparse structure | 7.5               | 0.7     |
| shape            | 7.5               | 0.5     |
| **texture**      | **1.0**           | **0.0** |

At exactly 1.0 the CFG mixin short-circuits (`classifier_free_guidance_mixin.py:10`) and returns the
plain conditional prediction — the negative branch is never evaluated. **Texture is the only stage
in either pipeline that gets no guidance toward the image.** That is upstream's default, not ours.

### The sweep: 4 strengths × 4 seeds, one mesh

| strength          | base-colour saturation | metallic | majority-metal | collapsed | cost |
| ----------------- | ---------------------- | -------- | -------------- | --------- | ---- |
| **1.0** (shipped) | 0.170                  | 0.921    | 4/4            | 0/4       | 15 s |
| 3.0               | 0.242                  | 0.922    | 4/4            | 0/4       | 15 s |
| 5.0               | 0.276                  | 0.922    | 4/4            | 0/4       | 15 s |
| **7.5**           | **0.290**              | 0.920    | 4/4            | 0/4       | 15 s |

Source saturation is **0.326**. Guidance closes 71% of the gap, monotonically, with no
oversaturation and **no measurable cost** — texture sampling is ~2 s of a 15 s run, so doubling its
model evaluations disappears into the noise.

**Retexture's default is now 7.5.** Generation keeps upstream's 1.0: its sweep has not been run, and
it already produces faithful colour on the one subject measured (0.319 against 0.326). Changing an
unswept default on another path's evidence is a mistake this backend has invited before.

## Cause 2: the model thinks the character is made of metal

Guidance does **not** touch this — 0.921 → 0.920 across the sweep. It is a separate failure, and it
was the dominant one.

|                                | metallic mean | texels > 0.5                   |
| ------------------------------ | ------------- | ------------------------------ |
| TRELLIS.2's own flower example | 0.056         | 1.7%                           |
| bulma, across 22 spike GLBs    | —             | **68% of runs majority-metal** |

That is the flower-vs-bulma gap. In a metal workflow base colour is specular reflectance and there
is **no diffuse albedo at all**, so a fully-metallic character reads as washed-out chrome in any PBR
viewer. Correlation between metallic and dark base colour is **+0.06** — two independent failures,
not one.

**The old gate could not see it: 9 of those 22 runs were majority-metal with a perfectly healthy
base colour, and the collapse check passed every one.** In the guidance sweep it passed 16 of 16.

### The gate

`quality_fault(mean, metal)` now rejects a sample for either reason. The metal threshold is the
**fraction** of lit texels above 0.5, not the mean, set at **0.60**. Observed failures cluster at
85–100% and good runs at 0–1.7%, so the valley is enormous and the cut is chosen for a case the
evidence does not contain: a character in plate armour is legitimately part metal, and no real
character — face, hair, leather, cloth — is 60% of its surface. The one observed failure below the
line (31% metal) had a base colour of 0.044 and is caught as a collapse instead.

## The result, end to end

`spritebook retexture --result r1 --seed 1234`, with the new default and the new gate:

```
seed 1234 -> rejected, an all-metal material (100% of the surface)
seed 1235 -> rejected, an all-metal material (100% of the surface)
seed 1236 -> accepted
done in 90.7s
```

| result             | metallic  | saturation | base  | gate       |
| ------------------ | --------- | ---------- | ----- | ---------- |
| r1 (generation)    | 0.0%      | 0.319      | 0.417 | pass       |
| r2 (old retexture) | 91.6%     | 0.130      | 0.475 | **reject** |
| r3 (old retexture) | 100.0%    | 0.095      | 0.242 | **reject** |
| r4 (old retexture) | 95.3%     | 0.063      | 0.175 | **reject** |
| **r5 (new)**       | **18.1%** | **0.369**  | 0.504 | pass       |

Source is 0.326, so r5 slightly **exceeds** the reference's saturation — worth watching if guidance
is ever pushed past 7.5, since oversaturation is the failure mode on that side.

An earlier read of the sweep said retexture on this subject was 100% metal and the gate would always
exhaust. That was four seeds. Seed 1236 disproves it: the ladder works, it costs two extra attempts
(~30 s), and it lands on a good result.

## Also fixed on the way

`steps` and `guidanceStrength` were declared in the gen params schema, validated, and written into
the receipt as provenance — and **never passed to the pipeline**. `--adjust guidanceStrength=12` was
accepted and did nothing. Both now reach the shape and sparse-structure samplers, and a test pins
that they arrive.

## Cross-subject: the metal problem is bulma's, not the path's

Three more subjects through the real verbs — `gen` once, `retexture` at two seeds each.

| subject           | style                | in TRELLIS.2's examples | retexture metal | ladder attempts |
| ----------------- | -------------------- | ----------------------- | --------------- | --------------- |
| **bulma**         | flat anime line art  | no                      | **76.2%**       | 3 (on r5)       |
| painted-mermaid   | painted illustration | yes                     | 7.6%            | 1, 1            |
| lineless-princess | lineless soft 3D     | yes                     | 0.1%            | 1, 1            |
| robot-astro       | glossy 3D robot      | no                      | 14.1%           | 1, 1            |

**Said plainly: the gate is idle on three subjects out of four.** The six retexture runs across the
three new subjects produced zero rejections, and every one accepted its first seed. Generation was
majority-metal 0 times out of 4. Bulma's own r2-r4 show one attempt each only because they predate
the gate; r5 is the only bulma retexture the ladder has actually run.

**And the metal channel is not tracking material semantics at all.** Astro Bot is a chrome-and-gloss
robot — the one subject here that should legitimately read metallic — and it comes back at 14%,
while a cartoon girl in a cotton shirt comes back at 76%. Whatever that channel is doing on bulma,
it is not describing the material.

The two example-set subjects carry a confound: clean is consistent with "not flat line art" AND with
"the model has seen this image". `robot-astro` is what breaks it — out of the example set, and
clean. So out-of-distribution alone does not explain bulma.

**An alternative this data cannot rule out.** Every bulma retexture encoded the same r1 mesh. A flat
anime reference produces a notably flat mesh, and the texturing pipeline conditions on the mesh it
is handed. The trigger may be bulma's GEOMETRY rather than her art style. Settled below.

## The crossover: it is the IMAGE, with nothing left over

Same seed in every cell; only the mesh and the conditioning image move. Seeds 1234 and 1235 were
picked because both return 100% metal in the control cell — a cell that starts clean cannot show
which swap rescued it.

| metallic (mean of 2 seeds) | image: bulma | image: mermaid |
| -------------------------- | ------------ | -------------- |
| **mesh: bulma**            | 100.0%       | **0.0%**       |
| **mesh: mermaid**          | **100.0%**   | 0.0%           |

    main effect of MESH  (bulma - mermaid):   -0.0%
    main effect of IMAGE (bulma - mermaid): +100.0%

**The IMAGE hypothesis survives and the MESH hypothesis is dead.** Not "mostly" — the mesh effect is
zero to the precision measured, and all four cells are saturated at 0% or 100% with no interaction
term and no partial credit. Bulma's own mesh painted from the mermaid's image is clean; the
mermaid's mesh painted from bulma's image is fully metal.

Three consequences:

- **The geometry is innocent**, so there is nothing to fix upstream in generation. The mesh bulma's
  gen pass produced is fine and stays fine.
- **Nothing in our pipeline can prevent it.** The conditioning image is the user's reference; we
  cannot rewrite it into something the decoder likes without changing the character.
- **The gate is the right answer**, not a workaround for a deeper bug. Detect, reject, reroll.

Saturation tracks the image too — bulma's mesh under the mermaid's image reaches 0.428, well above
what bulma's own image ever produced. The conditioning dominates both channels.

Renders: `out/crossover_sheet.png`. Re-run with `crossover.py`.

### Colour, judged by eye rather than by the mean

Guidance at 7.5 is right on all four. Saturation lands above source on two subjects — mermaid 0.504
against 0.289, princess 0.267 against 0.232 — which read on the sheet as _more vivid_, not garish;
the mermaid's jellyfish glow and the princess's pink recover detail her generation pass lost. On
`lineless-princess` the retextures are visibly BETTER than the generation, which is the first
evidence that this feature earns its place beyond rescuing a bad seed.

Rendered comparison: `out/cross_subject_rendered.png`.

## Still unknown

- **WHY a flat-line-art reference reads as metal.** The crossover proves the image is the trigger
  and the mesh is not; it says nothing about the mechanism. `preprocess_image` premultiplies onto
  black and bulma is full of black linework, which is a guess worth testing and nothing more.
- **Whether every flat-line-art reference does this**, or only this one. One image is one image.
- **Whether the 0.60 metal threshold is right.** It has now seen exactly one subject that trips it.
  Three others sit at 0-15%, comfortably clear, so the valley holds - but no run has landed between
  15% and 76%, which is where the threshold would actually be tested.
- **`guidance_rescale`** stayed at its shipped 0.0 so strength alone could be credited. Raising it
  is the standard remedy if higher strength ever burns colour.
- **Whether generation benefits too.** Untested, deliberately.
