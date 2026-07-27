"""
Wider evidence: mixed-tier vs plain 512 across 8 seeds, and does 5% hold on
other art styles?

Two jobs in one pipeline load:

  A. For each bulma reference and each seed, run BOTH `512` and MIXED
     (shape 1024_cascade + texture 512), saving a base_color render of each so
     the comparison can be judged by EYE. The mean is a proxy; the picture is
     the thing.

  B. Three more characters in different styles at 512 only, to test whether the
     5% collapse rate holds or whether some art is worse.

Caveat that belongs in the output, not just the report: the extra characters are
TRELLIS.2's OWN examples, so they are in-distribution and probably favourable.
They are weaker evidence than genuinely external art would be.
"""
import argparse
import json
import os
import time

os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'
os.environ.setdefault('ATTN_BACKEND', 'xformers')

import torch  # noqa: E402
from PIL import Image  # noqa: E402

COLLAPSE_MEAN = 0.10  # from the 40-run sweep; see ADAPTER-SKETCH.md


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', type=int, nargs='+', default=[0, 1, 7, 42, 123, 777, 1234, 2026])
    ap.add_argument('--out', default='out/wide')
    args = ap.parse_args()

    import run_matrix as M
    M.patch(None)
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    from trellis2.utils import render_utils
    pl = Trellis2ImageTo3DPipeline.from_pretrained(M.WEIGHTS)
    pl.cuda()
    env = M.envmap()
    os.makedirs(args.out, exist_ok=True)

    def mixed(img, seed):
        """1024_cascade shape latent, textured by the 512 model."""
        image = pl.preprocess_image(img)
        torch.manual_seed(seed)
        c512 = pl.get_cond([image], 512)
        c1024 = pl.get_cond([image], 1024)
        coords = pl.sample_sparse_structure(c512, 32, 1, {})
        shape_slat, res = pl.sample_shape_slat_cascade(
            c512, c1024, pl.models['shape_slat_flow_model_512'],
            pl.models['shape_slat_flow_model_1024'], 512, 1024, coords, {}, 49152)
        tex_slat = pl.sample_tex_slat(c512, pl.models['tex_slat_flow_model_512'],
                                      shape_slat, {})
        torch.cuda.empty_cache()
        return pl.decode_latent(shape_slat, tex_slat, res)[0]

    rows = []

    def record(subject, combo, seed, mesh, secs, render_to=None):
        bc = mesh.attrs.float()[:, 0:3]
        mean, mx = bc.mean().item(), bc.max().item()
        bad = mean < COLLAPSE_MEAN
        rows.append({'subject': subject, 'combo': combo, 'seed': seed,
                     'baseColorMean': round(mean, 4), 'baseColorMax': round(mx, 4),
                     'collapsed': bad, 'voxels': int(mesh.coords.shape[0]),
                     'seconds': round(secs, 1)})
        print(f'{subject:<14} {combo:<8} seed {seed:<6} mean {mean:.4f} '
              f'{"COLLAPSED" if bad else "ok"}', flush=True)
        if render_to:
            res = render_utils.render_video(mesh, resolution=384, num_frames=8, envmap=env)
            Image.fromarray(res['base_color'][6]).save(render_to)
        with open(os.path.join(args.out, 'wide.json'), 'w', newline='\n') as f:
            json.dump(rows, f, indent=2)

    # --- A: mixed vs 512, with renders ---------------------------------------
    for label, path in [('bulma-front', 'refs/bulma-front.png'),
                        ('bulma-iso', 'refs/bulma-iso.png')]:
        img = Image.open(path)
        for seed in args.seeds:
            t = time.perf_counter()
            m = pl.run(img, seed=seed, pipeline_type='512', preprocess_image=True)[0]
            record(label, '512', seed, m, time.perf_counter() - t,
                   os.path.join(args.out, f'{label}_512_s{seed}.png'))
            del m
            torch.cuda.empty_cache()

            t = time.perf_counter()
            m = mixed(img, seed)
            record(label, 'mixed', seed, m, time.perf_counter() - t,
                   os.path.join(args.out, f'{label}_mixed_s{seed}.png'))
            del m
            torch.cuda.empty_cache()

    # --- B: other art styles, 512 only ---------------------------------------
    E = 'code/assets/example_image'
    for label, fname in [
        ('steampunk-boy', '454e7d8a30486c0635369936e7bec5677b78ae5f436d0e46af0d533738be859f.webp'),
        ('mermaid-lineart', '8ce83f6a28910e755902de10918672e77dd23476f43f0f1521c48667de6cea84.webp'),
        ('dress-girl-soft', 'be7deb26f4fdd2080d4288668af4c39e526564282c579559ff8a4126ca4ed6c1.webp'),
    ]:
        img = Image.open(os.path.join(E, fname))
        for seed in args.seeds:
            t = time.perf_counter()
            m = pl.run(img, seed=seed, pipeline_type='512', preprocess_image=True)[0]
            record(label, '512', seed, m, time.perf_counter() - t)
            del m
            torch.cuda.empty_cache()

    print('\n=== collapse rate by subject/combo ===')
    keys = sorted({(r['subject'], r['combo']) for r in rows})
    for sub, combo in keys:
        rs = [r for r in rows if r['subject'] == sub and r['combo'] == combo]
        bad = [r for r in rs if r['collapsed']]
        print(f'{sub:<16}{combo:<8} {len(bad)}/{len(rs)}'
              + (f'  seeds {[r["seed"] for r in bad]}' if bad else ''))

    print('\n=== mixed vs 512, mean base_color per seed ===')
    for sub in ['bulma-front', 'bulma-iso']:
        for seed in args.seeds:
            g = {r['combo']: r for r in rows if r['subject'] == sub and r['seed'] == seed}
            if '512' in g and 'mixed' in g:
                a, b = g['512']['baseColorMean'], g['mixed']['baseColorMean']
                print(f'{sub:<14} seed {seed:<6} 512 {a:.4f}   mixed {b:.4f}   '
                      f'{"mixed" if b > a else "512"} higher')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
