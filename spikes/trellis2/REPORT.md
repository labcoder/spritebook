# Spike: does TRELLIS.2 run on Windows, wheels-only, inside 24 GB?

**Date:** 2026-07-27 · **Machine:** RTX 3090 (24 GiB, 22.79 free), Windows 11, driver 610.47

**Verdict: yes on all three counts — and D-028's blocker no longer holds.** But shipping it in a
downloadable app depends on two models that are neither TRELLIS.2's nor MIT, and one of them is
gated behind manual approval this spike could not grant itself.

## What was proven

| | |
|---|---|
| Wheels-only Windows install | **Yes.** Zero compilation. Five community CUDA extensions install from vendored `.whl` files and all five import against a live CUDA context. |
| Runs on a 3090 | **Yes.** All three sampling stages complete: sparse structure → shape SLat → texture SLat. |
| Peak VRAM, `512` | **2.89 GiB** reserved (2.65 allocated) |
| Peak VRAM, `1024_cascade` (default) | **3.11 GiB** reserved (2.66 allocated) |
| Headroom | ~7×. Nowhere near the 22.79 GiB free. |
| Wall time | load 81 s, run 65 s (`1024_cascade`) |
| Output density | 175,305 occupied voxels, 176,019 verts, 357,420 faces — real work, not an empty scene |

## Why the official README says 24 GB and we measured 3

`low_vram` defaults to **True** in the shipped `pipeline.json`, which loads each model to GPU for its
stage and offloads it afterwards. Peak is then one 1.3B DiT in bf16 (~2.6 GiB) plus activations —
which is exactly the 2.65 GiB allocated we measured. The 24 GB figure is the all-resident case:
~16 GB of weights on the card at once, plus activations.

So `dependencies.md`'s "16 GB VRAM" and D-028's "≥24 GiB" were both describing the wrong
configuration. The number that matters for us is **~3 GiB**, and it puts TRELLIS.2 within reach of
an 8 GB consumer card, not just a 3090.

## The blocker that is not about hardware

TRELLIS.2-4B's own weights are MIT. Its **pipeline** pulls two models that are neither:

| Model | Role | Gate | Licence | Replaceable? |
|---|---|---|---|---|
| `facebook/dinov3-vitl16-pretrain-lvd1689m` | image conditioning | **manual** approval | DINOv3 License | **No** — the whole model is conditioned on these features |
| `briaai/RMBG-2.0` | background removal | auto (accept terms) | "other" (BRIA) | **Yes** — SpriteBook already does its own cutout with u2net (Apache-2.0, catalogued) |

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

## Still unknown

- **Output quality.** Nothing here evaluated a real generation.
- **Real-image VRAM and time.** A real conditioning tensor changes the sparse structure, and peak
  scales with occupied voxels. 175k voxels is a healthy structure, so 3 GiB is a credible estimate
  rather than a floor — but it is an estimate until DINOv3 is unblocked.
- **The 81 s load** is 16 GB read from disk per stage. Worth measuring whether a warm sidecar
  amortises it, since our sidecar is a long-lived process.
