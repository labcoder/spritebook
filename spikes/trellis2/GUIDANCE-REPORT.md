# Why the texture never matched the reference

**Date:** 2026-07-28 · RTX 3090 · one mesh (`bulma` r1), one image, 16 runs + a live verb run

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

## Still unknown

- **One subject.** Every number here is bulma. The 7.5 default is safe (it only strengthens
  conditioning that already exists) but the _size_ of the gain is unmeasured elsewhere.
- **Whether the metal rate is subject-specific.** The flower says in-distribution art is fine; two
  more characters in different styles would say whether flat art is the trigger.
- **`guidance_rescale`** stayed at its shipped 0.0 so strength alone could be credited. Raising it
  is the standard remedy if higher strength ever burns colour.
- **Whether generation benefits too.** Untested, deliberately.
