"""
WHY is base_color black on flat 2D art? Seeds, and where in the chain it dies.

Two questions:
  1. Is it the seed? Every earlier run used 42 and only 42.
  2. Is the TEXTURE LATENT degenerate, or does a healthy latent decode to black?

The decoder ends `... * 0.5 + 0.5`, so its native range is [-1, 1] and a black
result means it is saturating to -1 — not drifting toward zero. That is what a
diverged sampler looks like, so the latent going in is where to look.
"""
import argparse
import os

os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'
os.environ.setdefault('ATTN_BACKEND', 'xformers')

import torch  # noqa: E402
from PIL import Image  # noqa: E402


def stats(t: torch.Tensor) -> str:
    f = t.float()
    return (f'mean {f.mean().item():+.4f}  std {f.std().item():.4f}  '
            f'min {f.min().item():+.4f}  max {f.max().item():+.4f}')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', type=int, nargs='+', default=[42, 0, 7, 1234, 2026])
    ap.add_argument('--type', default='512')
    ap.add_argument('--images', nargs='+', default=['refs/bulma-front.png'])
    args = ap.parse_args()

    import run_matrix as M
    M.patch(None)
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    pl = Trellis2ImageTo3DPipeline.from_pretrained(M.WEIGHTS)
    pl.cuda()

    # capture the texture latent on its way out of the sampler, before decode
    captured = {}
    orig = pl.sample_tex_slat

    def spy(cond, flow_model, shape_slat, sampler_params={}):
        out = orig(cond, flow_model, shape_slat, sampler_params)
        captured['tex_slat'] = out.feats.detach().clone()
        captured['shape_slat'] = shape_slat.feats.detach().clone()
        return out

    pl.sample_tex_slat = spy

    print(f'tex_slat_normalization: mean/std vectors of len '
          f'{len(pl.tex_slat_normalization["mean"])}\n')

    for path in args.images:
        img = Image.open(path)
        print(f'=== {os.path.basename(path)} @ {args.type} ===')
        for seed in args.seeds:
            mesh = pl.run(img, seed=seed, pipeline_type=args.type, preprocess_image=True)[0]
            bc = mesh.attrs.float()[:, 0:3]
            # the decoder emits [-1,1] then *0.5+0.5; recover what it actually said
            raw = bc * 2.0 - 1.0
            flag = 'BLACK' if bc.max().item() < 0.05 else 'ok'
            print(f'  seed {seed:<6} base_color mean {bc.mean().item():.4f} '
                  f'max {bc.max().item():.4f}  [decoder raw: {stats(raw)}]  {flag}')
            print(f'         tex_slat   {stats(captured["tex_slat"])}')
            print(f'         shape_slat {stats(captured["shape_slat"])}')
            del mesh
            torch.cuda.empty_cache()
        print()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
