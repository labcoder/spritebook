"""
N images x M pipeline types through ONE loaded pipeline.

Loading costs ~82 s (16 GB read from disk per stage). A long-lived sidecar pays
that once, so this measures it once and reports per-run cost separately — which
is the number that matters for "how long does a character take".

  python run_matrix.py --images refs/a.png refs/b.png --types 512 1024_cascade
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


def gib(n):
    return round(n / 1024 ** 3, 2)


class StubRembg:
    def __init__(self, *a, **k):
        pass

    def to(self, d):
        return self

    def cuda(self):
        return self

    def cpu(self):
        return self


def patch(mods):
    """rembg stub + the transformers-5 DINOv3 attribute move (see REPORT)."""
    import trellis2.pipelines.rembg as rembg_mod
    rembg_mod.BiRefNet = StubRembg
    from trellis2.pipelines import trellis2_image_to_3d as t23
    t23.rembg.BiRefNet = StubRembg
    import trellis2.modules.image_feature_extractor as ife

    def extract_features(self, image):
        import torch.nn.functional as F
        image = image.to(self.model.embeddings.patch_embeddings.weight.dtype)
        h = self.model.embeddings(image, bool_masked_pos=None)
        pos = self.model.rope_embeddings(image)
        blocks = getattr(self.model, 'layer', None) or self.model.model.layer
        for blk in blocks:
            h = blk(h, position_embeddings=pos)
        return F.layer_norm(h, h.shape[-1:])

    ife.DinoV3FeatureExtractor.extract_features = extract_features


def envmap():
    from trellis2.renderers import EnvMap
    h, w = 256, 512
    t = torch.linspace(1.0, 0.0, h, device='cuda').view(h, 1, 1)
    sky = torch.tensor([0.55, 0.68, 0.95], device='cuda').view(1, 1, 3)
    ground = torch.tensor([0.28, 0.26, 0.24], device='cuda').view(1, 1, 3)
    return EnvMap(((sky * t + ground * (1 - t)) * 1.15).expand(h, w, 3).contiguous())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--images', nargs='+', required=True)
    ap.add_argument('--types', nargs='+', default=['512', '1024_cascade'])
    ap.add_argument('--views', type=int, default=8)
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--out', default='out')
    args = ap.parse_args()

    patch(None)
    props = torch.cuda.get_device_properties(0)
    free0, total = torch.cuda.mem_get_info()
    print(f'GPU {props.name}  total {gib(total)} GiB  free {gib(free0)} GiB\n')

    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    from trellis2.utils import render_utils
    import o_voxel

    torch.cuda.reset_peak_memory_stats()
    t0 = time.perf_counter()
    pipeline = Trellis2ImageTo3DPipeline.from_pretrained(WEIGHTS)
    pipeline.cuda()
    load_s = round(time.perf_counter() - t0, 2)
    print(f'pipeline loaded ONCE in {load_s}s — every run below reuses it\n')

    env = envmap()
    rows = []
    for img_path in args.images:
        image = Image.open(img_path)
        if image.mode != 'RGBA':
            raise SystemExit(f'{img_path} is {image.mode}, need RGBA')
        stem = os.path.splitext(os.path.basename(img_path))[0]
        for ptype in args.types:
            outdir = os.path.join(args.out, f'{stem}_{ptype}')
            os.makedirs(outdir, exist_ok=True)
            image.save(os.path.join(outdir, 'input.png'))
            print(f'--- {stem} @ {ptype} ---', flush=True)

            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
            t = time.perf_counter()
            mesh = pipeline.run(image, seed=args.seed, pipeline_type=ptype,
                                preprocess_image=False)[0]
            torch.cuda.synchronize()
            run_s = round(time.perf_counter() - t, 2)
            peak = gib(torch.cuda.max_memory_reserved())
            alloc = gib(torch.cuda.max_memory_allocated())
            print(f'  run {run_s}s  peak {peak} GiB (alloc {alloc})  '
                  f'{mesh.coords.shape[0]:,} vox  {mesh.faces.shape[0]:,} faces', flush=True)

            t = time.perf_counter()
            res = render_utils.render_video(mesh, resolution=512,
                                            num_frames=args.views, envmap=env)
            for i, f in enumerate(res['shaded']):
                Image.fromarray(f).save(os.path.join(outdir, f'view_{i:02d}.png'))
            for i, f in enumerate(res['base_color'][:1]):
                Image.fromarray(f).save(os.path.join(outdir, 'basecolor_00.png'))
            for i, f in enumerate(res['normal'][:1]):
                Image.fromarray(f).save(os.path.join(outdir, 'normal_00.png'))
            render_s = round(time.perf_counter() - t, 2)

            t = time.perf_counter()
            mesh.simplify(16777216)
            glb = o_voxel.postprocess.to_glb(
                vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs,
                coords=mesh.coords, attr_layout=mesh.layout, voxel_size=mesh.voxel_size,
                aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
                decimation_target=200000, texture_size=2048,
                remesh=True, remesh_band=1, remesh_project=0, verbose=False)
            out_glb = os.path.join(outdir, 'model.glb')
            glb.export(out_glb)
            glb_s = round(time.perf_counter() - t, 2)

            rows.append({
                'image': stem, 'pipelineType': ptype, 'seed': args.seed,
                'peakReservedGiB': peak, 'peakAllocatedGiB': alloc,
                'voxels': int(mesh.coords.shape[0]),
                'vertices': int(mesh.vertices.shape[0]), 'faces': int(mesh.faces.shape[0]),
                'secondsRun': run_s, 'secondsRender': render_s, 'secondsGlb': glb_s,
                'secondsPerCharacter': round(run_s + glb_s, 2),
                'glbBytes': os.path.getsize(out_glb), 'outDir': outdir,
            })
            print(f'  render {render_s}s  glb {glb_s}s  '
                  f'{os.path.getsize(out_glb):,} bytes\n', flush=True)
            del mesh
            torch.cuda.empty_cache()

    summary = {'gpu': props.name, 'totalVramGiB': gib(total),
               'freeAtStartGiB': gib(free0), 'secondsLoadOnce': load_s, 'runs': rows}
    with open(os.path.join(args.out, 'matrix.json'), 'w', newline='\n') as f:
        json.dump(summary, f, indent=2)

    print(f'{"image":<16}{"type":<15}{"peak GiB":>9}{"run s":>8}{"glb s":>7}'
          f'{"voxels":>12}{"faces":>12}')
    for r in rows:
        print(f'{r["image"]:<16}{r["pipelineType"]:<15}{r["peakReservedGiB"]:>9.2f}'
              f'{r["secondsRun"]:>8.1f}{r["secondsGlb"]:>7.1f}'
              f'{r["voxels"]:>12,}{r["faces"]:>12,}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
