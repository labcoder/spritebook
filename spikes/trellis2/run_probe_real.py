"""
The real run: real DINOv3 conditioning, real image, real mesh you can look at.

Differs from run_probe_stub.py in the one way that matters — the image
conditioner is the actual gated `facebook/dinov3-vitl16-pretrain-lvd1689m`, so
the geometry means something and the numbers describe a genuine workload.

`briaai/RMBG-2.0` stays stubbed, and that is the production shape rather than a
shortcut: it is gated, it is not MIT, and SpriteBook already cuts out with u2net
(Apache-2.0, catalogued). An adapter passes `preprocess_image=False` and never
constructs BiRefNet, so the input must already carry alpha.

  python run_probe_real.py --type 1024_cascade --image <rgba.webp|png>

Writes out/<name>/: the GLB, N turntable PNGs for eyeballing, and probe.json.
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


def gib(n: int) -> float:
    return round(n / 1024 ** 3, 2)


class StubRembg:
    """Never called: preprocess_image=False. Exists so from_pretrained can build."""

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
    ap.add_argument('--type', default='1024_cascade')
    ap.add_argument('--image', required=True)
    ap.add_argument('--views', type=int, default=8, help='turntable PNGs to write')
    ap.add_argument('--out', default='out')
    args = ap.parse_args()

    import trellis2.pipelines.rembg as rembg_mod
    rembg_mod.BiRefNet = StubRembg
    from trellis2.pipelines import trellis2_image_to_3d as t23
    t23.rembg.BiRefNet = StubRembg

    # transformers 5.x moved the DINOv3 encoder blocks from `model.layer` to
    # `model.model.layer`, and TRELLIS.2 reaches for the old path. `embeddings`
    # and `rope_embeddings` are still top-level, so this is the whole delta.
    # A production adapter pins transformers instead of reaching into it; this
    # is a spike shim, and the rendered views are what say whether it is right.
    import trellis2.modules.image_feature_extractor as ife

    def extract_features(self, image):
        import torch.nn.functional as F
        image = image.to(self.model.embeddings.patch_embeddings.weight.dtype)
        hidden_states = self.model.embeddings(image, bool_masked_pos=None)
        position_embeddings = self.model.rope_embeddings(image)
        blocks = getattr(self.model, 'layer', None)
        if blocks is None:
            blocks = self.model.model.layer  # transformers >= 5
        for layer_module in blocks:
            hidden_states = layer_module(hidden_states, position_embeddings=position_embeddings)
        return F.layer_norm(hidden_states, hidden_states.shape[-1:])

    ife.DinoV3FeatureExtractor.extract_features = extract_features

    name = os.path.splitext(os.path.basename(args.image))[0][:16]
    outdir = os.path.join(args.out, f'{name}_{args.type}')
    os.makedirs(outdir, exist_ok=True)

    props = torch.cuda.get_device_properties(0)
    free, total = torch.cuda.mem_get_info()
    print(f'GPU {props.name}   total {gib(total)} GiB   free at start {gib(free)} GiB')
    print(f'pipeline_type {args.type}   image {args.image}   (REAL DINOv3)\n')

    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    with Peak('load pipeline') as p_load:
        pipeline = Trellis2ImageTo3DPipeline.from_pretrained(WEIGHTS)
        pipeline.cuda()

    image = Image.open(args.image)
    if image.mode != 'RGBA':
        raise SystemExit(
            f'--image must be RGBA (already cut out): {args.image} is {image.mode}. '
            'In production our u2net cutout stage produces this.'
        )
    image.save(os.path.join(outdir, 'input.png'))

    with Peak('run (image -> mesh)') as p_run:
        mesh = pipeline.run(image, seed=42, pipeline_type=args.type,
                            preprocess_image=False)[0]
    print(f'  -> {mesh.coords.shape[0]:,} voxels  {mesh.vertices.shape[0]:,} verts  '
          f'{mesh.faces.shape[0]:,} faces')

    with Peak('render turntable') as p_render:
        from trellis2.utils import render_utils
        from trellis2.renderers import EnvMap
        # A synthesized sky rather than the bundled .exr: OpenCV 5.0 ships
        # without EXR decode, so `cv2.imread` on assets/hdri/*.exr returns empty
        # and cvtColor dies on it. This is only lighting for a look-at-it
        # render, so a bright-top / dim-bottom gradient is enough and removes an
        # image-codec dependency from the probe entirely.
        h, w = 256, 512
        t = torch.linspace(1.0, 0.0, h, device='cuda').view(h, 1, 1)
        sky = torch.tensor([0.55, 0.68, 0.95], device='cuda').view(1, 1, 3)
        ground = torch.tensor([0.28, 0.26, 0.24], device='cuda').view(1, 1, 3)
        envmap = EnvMap(((sky * t + ground * (1 - t)) * 2.2).expand(h, w, 3).contiguous())
        res = render_utils.render_video(mesh, resolution=512, num_frames=args.views,
                                        envmap=envmap)
        for i, frame in enumerate(res['shaded']):
            Image.fromarray(frame).save(os.path.join(outdir, f'view_{i:02d}_shaded.png'))
        for i, frame in enumerate(res['base_color'][:2]):
            Image.fromarray(frame).save(os.path.join(outdir, f'view_{i:02d}_basecolor.png'))
        for i, frame in enumerate(res['normal'][:2]):
            Image.fromarray(frame).save(os.path.join(outdir, f'view_{i:02d}_normal.png'))

    with Peak('export glb') as p_glb:
        import o_voxel
        mesh.simplify(16777216)
        glb = o_voxel.postprocess.to_glb(
            vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs,
            coords=mesh.coords, attr_layout=mesh.layout, voxel_size=mesh.voxel_size,
            aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
            decimation_target=200000, texture_size=2048,
            remesh=True, remesh_band=1, remesh_project=0, verbose=False)
        out_glb = os.path.join(outdir, 'model.glb')
        glb.export(out_glb)

    peak = max(p_load.reserved, p_run.reserved, p_render.reserved, p_glb.reserved)
    result = {
        'pipelineType': args.type, 'image': args.image, 'conditioner': 'REAL DINOv3 ViT-L/16',
        'stubbed': ['briaai/RMBG-2.0 (preprocess_image=False; u2net does the cutout)'],
        'gpu': props.name, 'totalVramGiB': gib(total), 'freeAtStartGiB': gib(free),
        'peakReservedGiB': peak,
        'voxels': int(mesh.coords.shape[0]), 'vertices': int(mesh.vertices.shape[0]),
        'faces': int(mesh.faces.shape[0]),
        'secondsLoad': p_load.secs, 'secondsRun': p_run.secs,
        'secondsRender': p_render.secs, 'secondsGlb': p_glb.secs,
        'glb': out_glb, 'glbBytes': os.path.getsize(out_glb),
        'fitsInFreeVram': peak < gib(free),
    }
    print(f'\n  PEAK RESERVED {peak} GiB of {gib(free)} GiB free'
          f'   -> {"FITS" if result["fitsInFreeVram"] else "DOES NOT FIT"}')
    print(f'  {out_glb}  ({result["glbBytes"]:,} bytes)  +{args.views} views in {outdir}')
    with open(os.path.join(outdir, 'probe.json'), 'w', newline='\n') as f:
        json.dump(result, f, indent=2)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
