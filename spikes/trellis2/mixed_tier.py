"""
Can we shape at 1024 and texture at 512 — both tiers' strengths at once?

`run()` couples them: `pipeline_type` picks the shape path AND the texture
model. This re-implements the 1024_cascade branch with one substitution, the
512 texture flow model and its 512 conditioning, and compares four combinations
on the same seed so only the tier varies.

Honest about the risk: the 512 texture model may simply not accept a shape
latent produced at 1024. If it throws, that IS the answer and the script says
so rather than hiding it.
"""
import argparse
import json
import os
import time

os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'
os.environ.setdefault('ATTN_BACKEND', 'xformers')

import torch  # noqa: E402
from PIL import Image  # noqa: E402


def stats(mesh):
    bc = mesh.attrs.float()[:, 0:3]
    return round(bc.mean().item(), 4), round(bc.max().item(), 4), int(mesh.coords.shape[0])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', default='refs/bulma-front.png')
    ap.add_argument('--seeds', type=int, nargs='+', default=[7, 1234])
    ap.add_argument('--out', default='out/mixed_tier.json')
    args = ap.parse_args()

    import run_matrix as M
    M.patch(None)
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    pl = Trellis2ImageTo3DPipeline.from_pretrained(M.WEIGHTS)
    pl.cuda()
    img = Image.open(args.image)

    def mixed(seed: int, tex_res: int):
        """1024_cascade shape, texture from the model of `tex_res`."""
        image = pl.preprocess_image(img)
        torch.manual_seed(seed)
        cond_512 = pl.get_cond([image], 512)
        cond_1024 = pl.get_cond([image], 1024)
        coords = pl.sample_sparse_structure(cond_512, 32, 1, {})
        shape_slat, res = pl.sample_shape_slat_cascade(
            cond_512, cond_1024,
            pl.models['shape_slat_flow_model_512'], pl.models['shape_slat_flow_model_1024'],
            512, 1024, coords, {}, 49152)
        tex_cond = cond_512 if tex_res == 512 else cond_1024
        tex_model = pl.models[f'tex_slat_flow_model_{tex_res}']
        tex_slat = pl.sample_tex_slat(tex_cond, tex_model, shape_slat, {})
        torch.cuda.empty_cache()
        return pl.decode_latent(shape_slat, tex_slat, res)[0]

    rows = []
    for seed in args.seeds:
        for label, fn in [
            ('512 (shape+tex 512)', lambda s=seed: pl.run(
                img, seed=s, pipeline_type='512', preprocess_image=True)[0]),
            ('1024_cascade (both)', lambda s=seed: pl.run(
                img, seed=s, pipeline_type='1024_cascade', preprocess_image=True)[0]),
            ('MIXED shape1024/tex512', lambda s=seed: mixed(s, 512)),
        ]:
            t = time.perf_counter()
            try:
                mesh = fn()
                mean, mx, vox = stats(mesh)
                secs = round(time.perf_counter() - t, 1)
                print(f'seed {seed:<6} {label:<24} mean {mean:.4f} max {mx:.4f} '
                      f'{vox:>9,} vox  {secs}s', flush=True)
                rows.append({'seed': seed, 'combo': label, 'baseColorMean': mean,
                             'baseColorMax': mx, 'voxels': vox, 'seconds': secs})
                del mesh
            except Exception as e:
                print(f'seed {seed:<6} {label:<24} FAILED: {type(e).__name__}: '
                      f'{str(e)[:120]}', flush=True)
                rows.append({'seed': seed, 'combo': label, 'error': f'{type(e).__name__}: {e}'})
            torch.cuda.empty_cache()
    with open(args.out, 'w', newline='\n') as f:
        json.dump(rows, f, indent=2)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
