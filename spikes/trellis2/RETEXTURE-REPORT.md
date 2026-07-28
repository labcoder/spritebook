# Spike: retexturing an existing mesh

**Date:** 2026-07-27 · RTX 3090 · `Trellis2TexturingPipeline` against a GLB from an earlier `gen`

**The geometry gate passes. The texture reliability is much worse than full generation**, and that
is what decides how this feature should be built.

## Geometry: preserved

|                            |                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| surface deviation vs input | **mean 2.7e-4, max 9.7e-4 — 0.027% of model extent**                                      |
| faces                      | 199,959 → 199,959, **identical count**                                                    |
| bounds                     | `[-0.439,-0.501,-0.113]..[0.439,0.501,0.113]` → `[-0.438,-0.5,-0.113]..[0.438,0.5,0.113]` |
| area / volume              | −0.33% / −0.4%                                                                            |
| vertices                   | 168,239 → 170,763 (+1.5%)                                                                 |

The surface is the same to within a thousandth of the model's extent — sub-millimetre on a 1.8 m
character — and consistently so across seeds. The vertex growth is UV-seam splitting and the faces
come back reordered, so **it is the same SURFACE, not the same BUFFER**. "Keep the good mesh" is
true in the sense that matters for rigging and baking.

### I was wrong about the coordinate frame, and testing is why we know

The plan flagged a "critical finding" that `preprocess_mesh` recenters, rescales and swaps axes
(`y=-z, z=y`) with nothing inverting it — which would have meant every retextured character came
back rotated and rescaled. **It is inverted**, at `trellis2_texturing.py:359`:

```python
# Swap Y and Z axes, invert Y (common conversion for GLB compatibility)
vertices[:, 1], vertices[:, 2] = vertices[:, 2], -vertices[:, 1]
```

I had read `preprocess_mesh` and the first half of `postprocess_mesh` and stopped before the line
that undid it. **The adapter needs no inverse transform.** The runtime frame check is still worth
keeping — it is cheap and it is exactly the assumption that would break silently against another
backend — but it belongs as a guard, not as a correction.

## Texture: 3 of 8 seeds fail, and there are TWO failure modes

Eight seeds at `resolution=512`:

| seed     | mean       |                     |
| -------- | ---------- | ------------------- |
| 0        | 0.5714     | ok                  |
| 1        | 0.2685     | ok                  |
| **7**    | **0.0824** | **collapsed black** |
| 42       | 0.1145     | ok (marginal)       |
| 123      | 0.1994     | ok                  |
| **777**  | **0.0064** | **collapsed black** |
| 1234     | 0.3332     | ok                  |
| **2026** | **0.9987** | **saturated WHITE** |

**37.5% per-seed failure**, against 5% for full generation (2 of 40 runs). Retexturing fails roughly
seven times more often than generating from scratch.

**A new failure mode:** seed 2026 returns a pure white atlas — the decoder saturating at the TOP of
its range rather than the bottom. `COLLAPSE_MEAN = 0.10` as written would pass it, and the character
would bake as a featureless white silhouette. **The detector has to be two-sided.** A texture with
mean > 0.95 has no content either.

**And it resolves an open question from the earlier sweep.** Seed 42 was the only failing SEED
across 40 generation runs - it failed twice, on two different images - which looked like it might be
a globally bad seed. Here 42 is fine and 7 and 777 fail — while 7 was fine in generation. So the
failure is an interaction between a specific image, mesh and seed, not a property of the seed. The
ladder handles it either way.

## Cost

| resolution | peak VRAM   | per seed   |
| ---------- | ----------- | ---------- |
| 1024       | 6.9 GiB     | 25 s       |
| **512**    | **3.3 GiB** | **16.5 s** |

Roughly half the VRAM and two-thirds the time of a full generation, because sparse-structure and
shape sampling are skipped entirely. 512 is also cheaper here for the same reason it was there.

## What this means for the design

**The retry budget cannot be 2.** At 37.5%:

| retries | attempts | residual  | worst-case wall time |
| ------- | -------- | --------- | -------------------- |
| 2       | 3        | 5.3%      | 50 s                 |
| 4       | 5        | 0.74%     | 83 s                 |
| **5**   | **6**    | **0.28%** | **99 s**             |

`textureRetries` should default to **5** for retexture and stay at **2** for generation. They are
different failure rates and deserve different budgets — which argues for the budget living in the
catalog per adapter rather than as one shared constant.

**Honest counterpoint worth weighing before building.** A 37.5% failure rate means retexture is not
obviously cheaper than re-generating: 6 retexture attempts at 16.5 s (99 s) against 3 generation
attempts at 21 s (63 s), and generation also gives fresh geometry. Retexture's real value is
narrower than "cheaper" — it is **keeping a mesh you already like** while rerolling only the paint.
That is a genuine product capability, but it is a different claim from the one that motivated it,
and it should be built for that reason rather than for speed.

## Still unknown

- **One mesh, one image.** 8 seeds on a single character. The rate could differ per subject, as it
  did for generation.
- **Whether the white saturation appears in full generation too.** Nothing in the 40 generation runs
  hit it, but nothing was looking for it either — the detector was one-sided.
- **Whether a retexture of a retexture drifts.** Each pass re-splits UV seams and reorders faces;
  the surface held for one pass, and nobody has run two.
