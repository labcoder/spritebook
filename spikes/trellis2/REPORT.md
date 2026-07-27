# Spike: does TRELLIS.2 run on Windows, wheels-only, inside 24 GB?

**Date:** 2026-07-27 · **Machine:** RTX 3090 (24 GiB, 22.79 free), Windows 11, driver 610.47

**Verdict: yes on all three counts — and D-028's blocker no longer holds.** But shipping it in a
downloadable app depends on two models that are neither TRELLIS.2's nor MIT, and one of them is
gated behind manual approval this spike could not grant itself.

## What was proven

**Update 2026-07-27, second pass:** DINOv3 access was already granted on the maintainer's account.
My first check was an ANONYMOUS curl with no auth header, so its 401 said nothing about their
access — my error, not their account. With the token the repo returns 200 and the pipeline runs for
real. The numbers below are from that real run; the stub figures are kept underneath because the
gap between them is the interesting part.

| | Real DINOv3 | Stubbed conditioning |
|---|---|---|
| Wheels-only Windows install | **Yes.** Zero compilation; all five extensions import against a live CUDA context. | — |
| Runs on a 3090 | **Yes**, all three sampling stages | yes |
| Peak VRAM, `1024_cascade` | **9.26 GiB** reserved (5.74 alloc) | 3.11 GiB |
| Peak VRAM, `512` | not measured | 2.89 GiB |
| Wall time | load 82 s, run 73 s, render 7 s, glb 33 s | load 81 s, run 65 s |
| Structure | **4,789,987 voxels · 4.80 M verts · 10.33 M faces** | 175 k voxels · 176 k verts |
| GLB out | 21,142,280 bytes | — |
| Headroom | 2.5× — 9.26 of 22.79 GiB free | — |

**The stub understated peak VRAM by 3×**, exactly as its own caveat warned: peak scales with
occupied voxels, and a real conditioning tensor produces a 27× denser structure. Anyone quoting the
3 GiB figure would have been wrong. 9.26 GiB is the number that matters, and it still fits with
room to spare — an 8 GiB card would not, a 12 GiB card would.

**Output quality: good, and eyeballed rather than asserted.** `view_00` reproduces the input's pot,
leaf arrangement and flower colours; `view_04` (the unseen back) is a coherent complete object with
properly modelled rose geometry. Renders are in `out/<name>_<type>/`.

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
- **transformers 5.x moved the DINOv3 encoder blocks** from `model.layer` to `model.model.layer`,
  and TRELLIS.2 reaches for the old path — `AttributeError: 'DINOv3ViTModel' object has no
  attribute 'layer'`. `run_probe_real.py` shims it; a production adapter should PIN transformers
  rather than reach into it, and finding that pin is a task of its own.
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
pinned files, a `paramsSchema` (pipelineType / steps / seed / guidanceStrength), defaults, and
notes that ALREADY name the DINOv3 manual gate and ALREADY explain that RMBG-2.0 is skipped in
favour of our own Apache-2.0 u2net prep. That analysis was right the first time and this spike
mostly confirmed it.

One line in those notes is now wrong and needs replacing: *"ENV SPIKE VERDICT 2026-07-19 (D-028):
NOT installable under the wheels-only law today."* It is installable. The entry also has no
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
