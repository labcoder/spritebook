"""
Geometry-only turntables, for judging whether a mesh is riggable and bakeable.

Normals rather than shaded colour, deliberately: the texture stage collapses to
black on flat 2D art (see REPORT), so a lit render says nothing useful about the
SHAPE. Normals are lighting-independent and show exactly what matters here —
whether limbs separate from the torso, whether the face has relief, and whether
the silhouette is clean enough for an 8-direction bake.
"""
import argparse
import os

os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'
os.environ.setdefault('ATTN_BACKEND', 'xformers')

import torch  # noqa: E402
from PIL import Image  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--images', nargs='+', required=True)
    ap.add_argument('--type', default='1024_cascade')
    ap.add_argument('--views', type=int, default=8)
    ap.add_argument('--out', default='out/geometry')
    args = ap.parse_args()

    import run_matrix as M
    M.patch(None)
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    from trellis2.utils import render_utils

    pipeline = Trellis2ImageTo3DPipeline.from_pretrained(M.WEIGHTS)
    pipeline.cuda()
    env = M.envmap()

    for path in args.images:
        stem = os.path.splitext(os.path.basename(path))[0]
        outdir = os.path.join(args.out, stem)
        os.makedirs(outdir, exist_ok=True)
        mesh = pipeline.run(Image.open(path), seed=42, pipeline_type=args.type,
                            preprocess_image=True)[0]
        res = render_utils.render_video(mesh, resolution=512, num_frames=args.views,
                                        envmap=env)
        # one strip so the eight directions can be compared at a glance, which
        # is the same thing an 8-direction bake will be judged on
        strip = Image.new('RGB', (512 * args.views, 512), (40, 40, 40))
        for i, f in enumerate(res['normal']):
            im = Image.fromarray(f)
            im.save(os.path.join(outdir, f'normal_{i:02d}.png'))
            strip.paste(im, (i * 512, 0))
        strip.save(os.path.join(outdir, 'normals_strip.png'))
        print(f'{stem}: {mesh.coords.shape[0]:,} vox  {mesh.faces.shape[0]:,} faces '
              f'-> {outdir}', flush=True)
        del mesh
        torch.cuda.empty_cache()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
