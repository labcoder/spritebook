"""
VRAM probe with the two GATED models stubbed out.

Why this exists: TRELLIS.2's pipeline pulls two models that are NOT its own and
NOT MIT — `facebook/dinov3-vitl16-pretrain-lvd1689m` (manual gate) for image
conditioning and `briaai/RMBG-2.0` (auto gate) for background removal. Neither
can be downloaded without the maintainer accepting those licences on their own
Hugging Face account, which is their decision to make and not this script's.

So this measures what it honestly can: the expensive part. Peak VRAM is
dominated by the 1.3B DiT flow models and the shape/texture decoders, all of
which are the real weights doing real work. The conditioner is replaced by a
random tensor of the correct shape (ViT-L/16 at 512 -> 1024 patches x 1024 dim),
so the NUMBERS ARE REAL AND THE MESH IS GARBAGE. Do not look at the output.

RMBG is stubbed because SpriteBook does its own cutout anyway (u2net,
Apache-2.0, already in the catalog), so a production adapter would pass
`preprocess_image=False` and never construct BiRefNet at all.
"""
import argparse
import json
import os
import time

os.environ['OPENCV_IO_ENABLE_OPENEXR'] = '1'
os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'
os.environ.setdefault('ATTN_BACKEND', 'xformers')

import torch  # noqa: E402
from PIL import Image  # noqa: E402

WEIGHTS = r'C:\Users\oms10\AppData\Local\spritebook\models\trellis2-4b\af44b45f'
DINO_DIM = 1024      # ViT-L/16 hidden size
DINO_PATCHES = 1024  # (512/16)^2


def gib(n: int) -> float:
    return round(n / 1024 ** 3, 2)


class StubDino:
    """Correct-shaped conditioning features, so the DiT stages do real work."""

    def __init__(self, *a, **k):
        self.image_size = 512

    def to(self, device):
        return self

    def cuda(self):
        return self

    def cpu(self):
        return self

    @torch.no_grad()
    def __call__(self, image):
        n = len(image) if isinstance(image, list) else image.shape[0]
        g = torch.Generator(device='cuda').manual_seed(42)
        return torch.randn(n, DINO_PATCHES, DINO_DIM, generator=g,
                           device='cuda', dtype=torch.float32)


class StubRembg:
    """Never used: the adapter passes preprocess_image=False."""

    def __init__(self, *a, **k):
        pass

    def to(self, device):
        return self

    def cuda(self):
        return self

    def cpu(self):
        return self


class Peak:
    def __init__(self, label):
        self.label = label

    def __enter__(self):
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc):
        torch.cuda.synchronize()
        self.secs = round(time.perf_counter() - self.t0, 2)
        self.alloc = gib(torch.cuda.max_memory_allocated())
        self.reserved = gib(torch.cuda.max_memory_reserved())
        print(f'  {self.label:<24} {self.secs:>7.2f}s   peak alloc {self.alloc:>6.2f} GiB   '
              f'reserved {self.reserved:>6.2f} GiB', flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--type', default='512')
    ap.add_argument('--out', default='out')
    args = ap.parse_args()

    import trellis2.modules.image_feature_extractor as ife
    import trellis2.pipelines.rembg as rembg_mod
    ife.DinoV3FeatureExtractor = StubDino
    rembg_mod.BiRefNet = StubRembg
    from trellis2.pipelines import trellis2_image_to_3d as t23
    t23.image_feature_extractor.DinoV3FeatureExtractor = StubDino
    t23.rembg.BiRefNet = StubRembg

    props = torch.cuda.get_device_properties(0)
    free, total = torch.cuda.mem_get_info()
    print(f'GPU {props.name}   total {gib(total)} GiB   free at start {gib(free)} GiB')
    print(f'pipeline_type {args.type}   (DINOv3 + RMBG stubbed — VRAM real, mesh garbage)\n')

    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    with Peak('load pipeline') as p_load:
        pipeline = Trellis2ImageTo3DPipeline.from_pretrained(WEIGHTS)
        pipeline.cuda()

    # a plain RGBA square stands in for an already-cut-out sprite reference
    image = Image.new('RGBA', (512, 512), (180, 140, 90, 255))
    with Peak('run (cond -> mesh)') as p_run:
        mesh = pipeline.run(image, seed=42, pipeline_type=args.type,
                            preprocess_image=False)[0]

    peak_reserved = max(p_load.reserved, p_run.reserved)
    free_end, _ = torch.cuda.mem_get_info()
    result = {
        'pipelineType': args.type,
        'stubbed': ['facebook/dinov3-vitl16-pretrain-lvd1689m', 'briaai/RMBG-2.0'],
        'gpu': props.name,
        'totalVramGiB': gib(total),
        'freeAtStartGiB': gib(free),
        'peakReservedGiB': peak_reserved,
        'peakAllocatedGiB': max(p_load.alloc, p_run.alloc),
        'secondsLoad': p_load.secs,
        'secondsRun': p_run.secs,
        'fitsInFreeVram': peak_reserved < gib(free),
    }
    print(f'\n  PEAK RESERVED {peak_reserved} GiB   of {gib(free)} GiB free at start'
          f'   -> {"FITS" if result["fitsInFreeVram"] else "DOES NOT FIT"}')
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, f'probe_stub_{args.type}.json'), 'w', newline='\n') as f:
        json.dump(result, f, indent=2)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
