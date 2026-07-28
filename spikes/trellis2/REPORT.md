# Spike: does TRELLIS.2 run on Windows, wheels-only, inside 24 GB?

**Date:** 2026-07-27 · **Machine:** RTX 3090 (24 GiB, 22.79 free), Windows 11, driver 610.47

**Verdict: yes on all three counts — and D-028's blocker no longer holds.** But shipping it in a
downloadable app depends on two models that are neither TRELLIS.2's nor MIT, and one of them is
gated behind manual approval this spike could not grant itself.

## What was proven

**Update 2026-07-27, second pass:** DINOv3 access was already granted on the maintainer's account.
My first check was an ANONYMOUS curl with no auth header, so its 401 said nothing about their access
— my error, not their account. With the token the repo returns 200 and the pipeline runs for real.
The numbers below are from that real run; the stub figures are kept underneath because the gap
between them is the interesting part.

|                             | Real DINOv3                                                                        | Stubbed conditioning       |
| --------------------------- | ---------------------------------------------------------------------------------- | -------------------------- |
| Wheels-only Windows install | **Yes.** Zero compilation; all five extensions import against a live CUDA context. | —                          |
| Runs on a 3090              | **Yes**, all three sampling stages                                                 | yes                        |
| Peak VRAM, `1024_cascade`   | **9.26 GiB** reserved (5.74 alloc)                                                 | 3.11 GiB                   |
| Peak VRAM, `512`            | not measured                                                                       | 2.89 GiB                   |
| Wall time                   | load 82 s, run 73 s, render 7 s, glb 33 s                                          | load 81 s, run 65 s        |
| Structure                   | **4,789,987 voxels · 4.80 M verts · 10.33 M faces**                                | 175 k voxels · 176 k verts |
| GLB out                     | 21,142,280 bytes                                                                   | —                          |
| Headroom                    | 2.5× — 9.26 of 22.79 GiB free                                                      | —                          |

**The stub understated peak VRAM by 3×**, exactly as its own caveat warned: peak scales with
occupied voxels, and a real conditioning tensor produces a 27× denser structure. Anyone quoting the
3 GiB figure would have been wrong. 9.26 GiB is the number that matters, and it still fits with room
to spare — an 8 GiB card would not, a 12 GiB card would.

**Output quality: good, and eyeballed rather than asserted.** `view_00` reproduces the input's pot,
leaf arrangement and flower colours; `view_04` (the unseen back) is a coherent complete object with
properly modelled rose geometry. Renders are in `out/<name>_<type>/`.

## Why the official README says 24 GB and we measured 3

`low_vram` defaults to **True** in the shipped `pipeline.json`, which loads each model to GPU for
its stage and offloads it afterwards. Peak is then one 1.3B DiT in bf16 (~2.6 GiB) plus activations
— which is exactly the 2.65 GiB allocated we measured. The 24 GB figure is the all-resident case:
~16 GB of weights on the card at once, plus activations.

So `dependencies.md`'s "16 GB VRAM" and D-028's "≥24 GiB" were both describing the wrong
configuration. The measured peaks are **9.26 GiB** (a dense plant) and **5.22 GiB** (a character),
so the catalog gate is set to **12 GiB** — the smallest card with genuine headroom once the desktop
takes its ~1.2 GiB. Not the ~3 GiB the stubbed probe suggested; see the second spike below for why
that figure was wrong.

## The blocker that is not about hardware

TRELLIS.2-4B's own weights are MIT. Its **pipeline** pulls two models that are neither:

| Model                                      | Role               | Gate                | Licence        | Replaceable?                                                                         |
| ------------------------------------------ | ------------------ | ------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `facebook/dinov3-vitl16-pretrain-lvd1689m` | image conditioning | **manual** approval | DINOv3 License | **No** — the whole model is conditioned on these features                            |
| `briaai/RMBG-2.0`                          | background removal | auto (accept terms) | "other" (BRIA) | **Yes** — SpriteBook already does its own cutout with u2net (Apache-2.0, catalogued) |

`from_pretrained` constructs both eagerly, so the run dies at load with `403 gated repo` before it
reaches any of our code. The maintainer's HF token is present but returns **401** for DINOv3 — the
manual gate has not been granted.

**Accepting a licence on someone's account is their decision, so this spike did not route around
it.** Instead it stubbed both models with correctly-shaped substitutes and measured the expensive
part. The DiT stages, the decoders and every CUDA extension are the real weights doing real work;
only the 1024×1024 conditioning tensor is random. **VRAM and wall time are real. The mesh is
garbage** — nothing here says anything about output quality.

### DINOv3's licence is workable

Read at [Meta's licence page](https://ai.meta.com/resources/models-and-libraries/dinov3-license/):
commercial use permitted, redistribution permitted provided the agreement travels with the weights,
no territory or user-count limits. The price is an attribution: **"Built with DINOv3"** must appear
in the product's UI, docs or about page. That is a product decision, not a blocker.

## Reproducing this

```
uv venv --python 3.11 .venv
uv pip install torch==2.8.0 torchvision --index-url https://download.pytorch.org/whl/cu128
uv pip install xformers==0.0.32.post2 --index-url https://download.pytorch.org/whl/cu128
uv pip install wheels/*.whl            # verify against wheels.lock.json FIRST
uv pip install imageio imageio-ffmpeg tqdm easydict ninja trimesh transformers \
               tensorboard pandas lpips zstandard kornia timm safetensors \
               opencv-python-headless
uv pip install "utils3d @ git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e"
git clone --depth 1 https://github.com/microsoft/TRELLIS.2.git code
PYTHONPATH=code .venv/Scripts/python.exe run_probe_stub.py --type 1024_cascade
```

Notes that cost time:

- **`ATTN_BACKEND=xformers` is required.** Sparse attention supports only `xformers`, `flash_attn`
  and `flash_attn_3` — there is no SDPA fallback, and flash-attn needs a compiler. xformers ships a
  PyPI wheel for torch 2.8.0+cu128, so this stays wheels-only.
- **transformers 5.x moved the DINOv3 encoder blocks** from `model.layer` to `model.model.layer`,
  and TRELLIS.2 reaches for the old path —
  `AttributeError: 'DINOv3ViTModel' object has no
  attribute 'layer'`. `run_probe_real.py` shims
  it; a production adapter should PIN transformers rather than reach into it, and finding that pin
  is a task of its own.
- **OpenCV 5.0 ships without EXR decode**, so `cv2.imread` on the bundled `assets/hdri/*.exr`
  returns empty and `cvtColor` dies on it. The probe synthesizes a gradient envmap instead, which
  also drops an image-codec dependency. Only affects the preview render, not generation.
- `o_voxel` imports `cv2`; install `opencv-python-headless` or it fails at import.
- `expandable_segments` is unsupported on Windows — harmless warning.
- The wheels are **cp311/cp312 only**. The machine's system Python is 3.14, so the env must pin its
  own interpreter; uv does this. There is an open upstream request for cp314 wheels.

## Supply chain

The five extension wheels are community builds by one maintainer, who also runs custom forks of
TRELLIS.2, CuMesh and FlexGEMM. `wheels.lock.json` pins each by sha256 against repo commit
`438fe4e2a15bd29620a1cedad0a87c5afad6f81d`, so we install from bytes we have verified rather than
from a URL that can move under us. For a shipped app they should be mirrored to our own storage and
installed through the registry's existing hash gate, exactly as model weights already are.

## What the catalog already knew

`packages/registry/catalog/models.json` has carried a `trellis2-4b` entry since P3-T2, with 22
pinned files, a `paramsSchema` (pipelineType / steps / seed / guidanceStrength), defaults, and notes
that ALREADY name the DINOv3 manual gate and ALREADY explain that RMBG-2.0 is skipped in favour of
our own Apache-2.0 u2net prep. That analysis was right the first time and this spike mostly
confirmed it.

One line in those notes is now wrong and needs replacing: _"ENV SPIKE VERDICT 2026-07-19 (D-028):
NOT installable under the wheels-only law today."_ It is installable. The entry also has no
`minVramGb`, and 9.26 GiB measured is the number to put there.

## Still unknown

- **A CHARACTER.** The verified image is a potted plant from the model's own examples. Sprite work
  is humanoid, and nothing here says how it handles one — that is the next thing to look at, with
  our own reference art.
- **512 at real conditioning.** Only `1024_cascade` was measured for real; the 512 tier's true peak
  is still unmeasured and matters for smaller cards.
- **The 82 s load** is 16 GB read from disk per stage. Worth measuring whether a warm sidecar
  amortises it, since our sidecar is a long-lived process.
- **The transformers pin.** The shim works; the version that needs no shim is unidentified.

---

# Second spike, 2026-07-27: a real character

Two references of the same character, chroma-keyed from a green screen with despill: `bulma-front`
(straight-on T-pose) and `bulma-iso` (same pose, slightly rotated). Four runs through ONE loaded
pipeline, plus controls.

## Numbers

| image | type         | peak GiB | run s | glb s | voxels    | faces     |
| ----- | ------------ | -------- | ----- | ----- | --------- | --------- |
| front | 512          | 3.01     | 62.6  | 11.3  | 463,545   | 1,038,238 |
| front | 1024_cascade | 4.45     | 64.8  | 16.7  | 1,803,504 | 3,757,648 |
| iso   | 512          | 3.25     | 21.9  | 11.7  | 535,057   | 1,412,638 |
| iso   | 1024_cascade | 5.22     | 39.7  | 17.1  | 2,062,584 | 4,308,804 |

A character costs **less** VRAM than the plant (9.26 GiB) — 5.22 GiB at the heaviest. The 82 s load
happens ONCE for a long-lived process; per character is then ~40-80 s of sampling plus ~11-17 s of
GLB export.

## Geometry: good, and riggable

Judged on normals, which are lighting-independent. Limbs **separate cleanly** — both arms fully
detached from the torso with fingers resolved on both hands, which is what Track B needs to place
shoulder and elbow joints. The **face survives with real relief**: eyes, nose and bangs are modelled
rather than painted. Belt buckle, skirt pocket, leg warmers and laced high-tops all come through.
Silhouettes are clean from all eight directions.

## Texture: I GOT THIS WRONG — it is the SEED, not the art style

**Retracted.** This section previously claimed "the texture stage fails on flat 2D art", with a
measured table behind it. That conclusion was wrong, and the way it was wrong is worth more than the
conclusion was: **every run in it used `seed=42`.** My controls varied the SUBJECT (plant, witch)
while holding the seed fixed, so they could not distinguish "art style" from "seed" — they were
never controls for the thing I blamed.

Sweeping seeds at 512:

| subject         | seed 42          | seed 7    | seed 1234 |
| --------------- | ---------------- | --------- | --------- |
| bulma-front     | **0.0000 BLACK** | 0.4070 ok | 0.4539 ok |
| bulma-iso       | **0.0006 BLACK** | 0.2481 ok | 0.3185 ok |
| witch (control) | 0.1801 ok        | 0.2827 ok | 0.1808 ok |

Seed 42 is a dead end for BOTH Bulma references and fine for the witch. Nothing about the art style
is broken.

### What actually happens, measured

The texture decoder emits in [-1, 1] and the pipeline maps it with `* 0.5 + 0.5`. In the failing
runs it emits **mean -0.9988, std 0.0008** — a CONSTANT pinned at the bottom of its range, not noise
and not a dark texture.

The latent going INTO that decoder is healthy: `tex_slat` mean +0.30, std 3.59 for the black run,
against +0.37/+0.64 and std 2.9-3.6 for runs that worked. So the sampler produced something with
entirely normal statistics that the decoder nonetheless collapsed. Whatever the mechanism, it is
seed-dependent and it saturates rather than degrades.

### 512 textures more reliably than 1024_cascade

At `1024_cascade` with a good seed (7), base_color comes back at 0.1040 — skin, bow and eyes are
present but the clothing is crushed toward black. At `512` the same input gives 0.41-0.45 and the
render shows teal hair, red bow, salmon shirt, navy skirt, purple leg warmers and teal shoes: the
full palette, a little desaturated. **For 2D character art, 512 is the better texture tier** even
though 1024_cascade is the better geometry tier.

### What this means for the adapter

Not "geometry-only". The backend can texture this art, but it needs:

- **seed retries with a black-output detector.** `base_color.max() < 0.05` is an unambiguous
  signature — a real texture always has SOME bright texel — so the adapter can detect the collapse
  and re-sample on the next seed rather than shipping a black character. SpriteBook already records
  the seed in every `GenerationResult`, so a retry stays reproducible.
- **the option to texture at 512 while shaping at 1024**, since the two tiers disagree about which
  is better.

## Which input angle to recommend

**Straight-on.** Both produce good bodies, but the iso reference's face comes back closer to a
smooth blob with faint eye indentations, while the straight-on reference keeps modelled eyes and a
nose. The iso version also produces ~14% more voxels without a quality gain. Guidance for users:
face the camera square-on.

## Catalog updated

`minVramGb: 12`, not the 9.26 measured. A gate that admits a machine which then OOMs is worse than
no gate: a 10 GiB card has ~8.8 GiB free once Windows takes its ~1.2 GiB (24.0 total vs 22.79 free,
observed here), so 10 would pass and fail. 12 is the smallest card that genuinely fits. `lowVram`
joins `paramsSchema` defaulting true — it is the single reason peak is ~9 GiB and not ~24. The stale
"NOT installable under the wheels-only law" verdict is gone, and the texture limit is recorded in
its place.
