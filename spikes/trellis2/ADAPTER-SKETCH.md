# Sketch: the `trellis2` sidecar adapter

Not production code — a shape to argue with before anything is written. Follows
`sidecar/spritebook_sidecar/adapters/`'s existing contract: declare `id`, `kind`, `version`,
`params_schema`, `defaults`, `description`, and a `run(params, emit)` that emits through the
JobEmitter and raises `AdapterError` on failure.

## What the spike says the adapter must do

1. **Never construct BiRefNet.** `preprocess_image()` skips rembg entirely when the input already
   carries alpha, so passing an RGBA image from our own u2net prep avoids the gated, non-commercial
   `briaai/RMBG-2.0` without any patching. Pass `preprocess_image=True` and an RGBA image — NOT
   `preprocess_image=False`, which skips the crop-and-premultiply the model expects.
2. **Detect the texture collapse and retry on another seed.** See below.
3. **Pin `transformers`**, or shim the DINOv3 attribute move. The spike shims; production pins.
4. **Set `ATTN_BACKEND=xformers`** before importing trellis2. There is no SDPA fallback.
5. **Refuse early when DINOv3 is not accessible**, with the message naming the gate — not a 403
   stack trace 80 seconds into a load.

## The collapse detector — MEAN, not max

My first draft of this used `base_color.max() < 0.05`. **The 40-run sweep proved that wrong**: it
catches only one of the two real failures. `bulma-front` at seed 42 came back with `max 0.9856` — a
handful of bright texels — while its `mean` was 0.0415 and the baked GLB texture was black
(mean 0.003). A detector that passes an unusable character is worse than none.

The sweep gives the threshold empirically rather than by taste:

| | mean |
|---|---|
| worst FAILURE | 0.0415 (`bulma-front`, seed 42) |
| hard collapse | 0.0006 (`bulma-iso`, seed 42) |
| **worst HEALTHY** | **0.1473** (`bulma-iso`, seed 777) |
| legitimately dark control (witch) | 0.18 – 0.28 |
| brightest | 0.7229 |

`0.10` sits in the gap: 2.4× above the worst failure, 1.5× below the worst healthy result. Not a
tuned knob — a valley with nothing in it across 40 runs.

```python
# A collapsed texture is not a dark texture. Measured across 40 runs (4 subjects
# x 10 seeds): healthy output means 0.147..0.723 including a deliberately dark
# subject at 0.18, while the two failures sat at 0.0415 and 0.0006. `max` alone
# does NOT separate them -- one failure had max 0.9856 from a few stray texels.
COLLAPSE_MEAN = 0.10


def collapsed(mesh) -> bool:
    return float(mesh.attrs[:, 0:3].mean()) < COLLAPSE_MEAN
```

## The retry loop

```python
def run(params, emit):
    p = validate_params(PARAMS_SCHEMA, params, DEFAULTS)
    seed, budget = int(p["seed"]), int(p["textureRetries"])

    pipeline = load_pipeline(p["modelDir"])          # cached across jobs; ~82 s cold
    image = Image.open(p["imagePath"])               # RGBA from our u2net prep
    if image.mode != "RGBA":
        raise AdapterError("bad-input", "gen3d expects a cut-out RGBA image ...")

    attempts = []
    for i in range(budget + 1):
        s = seed + i                                  # deterministic ladder, not random
        emit.progress(f"generate:seed{s}", i + 1, budget + 1)
        mesh = pipeline.run(image, seed=s, pipeline_type=p["pipelineType"],
                            preprocess_image=True)[0]
        attempts.append(s)
        if not collapsed(mesh):
            break
        emit.warn("texture-collapsed",
                  f"seed {s} produced a black texture (a known TRELLIS.2 failure); "
                  f"retrying on seed {s + 1}")
        del mesh
    else:
        # Every seed in the budget collapsed. Do NOT ship a black character and
        # do NOT silently fall back -- say what happened and what to do.
        raise AdapterError(
            "texture-collapsed",
            f"all {budget + 1} seeds ({attempts}) produced a black texture. "
            f"Re-run with a different --seed, or generate geometry-only and let "
            f"the texture substage paint it.",
            retryable=True,
        )
```

**The seed that WORKED is what gets recorded.** `GenerationResult.seed` must be the effective seed,
not the requested one, or "re-run exactly this" reproduces the failure instead of the result. That
is a change in how the gen job fills the receipt, not just adapter-local.

## Params

```python
PARAMS_SCHEMA = {
    "type": "object",
    "required": ["imagePath", "outDir", "seed", "modelDir"],
    "properties": {
        "imagePath":      {"type": "string", "minLength": 1},
        "outDir":         {"type": "string", "minLength": 1},
        "modelDir":       {"type": "string", "minLength": 1},
        "seed":           {"type": "integer", "minimum": 0},
        "pipelineType":   {"type": "string", "enum": ["512", "1024", "1024_cascade"]},
        "steps":          {"type": "integer", "minimum": 1, "maximum": 50},
        "guidanceStrength": {"type": "number", "minimum": 0, "maximum": 20},
        "lowVram":        {"type": "boolean"},
        "textureRetries": {"type": "integer", "minimum": 0, "maximum": 8},
        "textureSize":    {"type": "integer", "enum": [1024, 2048, 4096]},
        "decimationTarget": {"type": "integer", "minimum": 10000, "maximum": 2000000},
    },
    "additionalProperties": False,
}
```

`decimationTarget` matters more than it looks: raw output is 3-10 M faces, which is far past what a
sprite bake needs and what UniRig wants to rig. 200 k was used throughout the spike.

## Retry budget: 2 is ample

Measured failure rate is **5% per seed on character art** (2 of 40 runs unusable; 1 of 40 a hard
collapse). Both failures were seed 42; the witch and plant never failed on any of the ten seeds.

| retries | attempts | residual failure |
|---|---|---|
| 1 | 2 | 0.25% |
| **2** | **3** | **0.0125%** |
| 3 | 4 | 0.0006% |

`textureRetries` defaults to **2**. At 21 s per 512 attempt the expected cost of retrying is about
1 second amortised, so this is close to free — and crucially it means **the texture substage is not
needed as a rescue**. It stays an optional quality upgrade, not a dependency.

Caveat worth keeping: independence across seeds is assumed, not proven. Both observed failures
landed on the same seed value across two different images, which is either coincidence at n=2 or a
hint that some seeds are globally worse. The ladder (`seed`, `seed+1`, `seed+2`) sidesteps it either
way, since consecutive seeds give unrelated RNG states.

## Tiers: mixed shape-1024 / texture-512 works, and looks best

`run()` couples the two, but the branch can be re-implemented with the 512 texture model against a
1024 shape latent. It runs, and on both seeds tried it beat `1024_cascade`'s own texture while
keeping its geometry:

| seed | 512 both | 1024_cascade both | MIXED shape1024/tex512 |
|---|---|---|---|
| 7 | 0.4070 | 0.1040 | 0.1819 |
| 1234 | 0.4539 | 0.3080 | **0.5921** |

Voxels track the shape tier exactly (1.85 M for both 1024 variants vs 0.45 M at 512), so the
geometry really is the 1024 one. **n=2, and mean base_color is a proxy for quality rather than
quality itself** — this needs a wider sweep and eyeballing before it becomes the default. But it is
viable, and it is the combination worth testing next.

## Open questions this sketch does not settle

- **Whether the mixed tier should be the default**, on evidence wider than two seeds and judged by
  eye rather than by a mean.
- **Whether some seeds are globally bad.** Both failures were seed 42, on two different images.
- **Whether the pipeline stays resident between jobs.** The 82 s load dominates a single character
  and vanishes across a roster. The sidecar is long-lived, so caching is natural, but it holds
  ~16 GB of host RAM and that is a real cost to declare.
