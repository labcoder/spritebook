"""
How often does the texture decoder collapse? Failure RATE, per subject.

The retry budget in the adapter depends entirely on this number. A 1-in-10
nuisance is two retries; a 1-in-3 problem needs a different design, and might
mean the texture substage is the primary path after all.

Skips rendering and GLB export — only `base_color` matters here, and the run is
the expensive part. Writes results incrementally so a long sweep can be watched.
"""
import argparse
import json
import os
import time

os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'
os.environ.setdefault('ATTN_BACKEND', 'xformers')

import torch  # noqa: E402
from PIL import Image  # noqa: E402

# a real texture always has SOME bright texel; a collapse pins every one of them
# at the bottom of the decoder's range. 0.05 sits far from both populations.
COLLAPSE_MAX = 0.05


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', type=int, nargs='+',
                    default=[0, 1, 7, 42, 123, 777, 1234, 2026, 31337, 99999])
    ap.add_argument('--type', default='512')
    ap.add_argument('--subjects', nargs='+', required=True,
                    help='label=path pairs')
    ap.add_argument('--out', default='out/seed_sweep.json')
    args = ap.parse_args()

    subjects = [s.split('=', 1) for s in args.subjects]

    import run_matrix as M
    M.patch(None)
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    pl = Trellis2ImageTo3DPipeline.from_pretrained(M.WEIGHTS)
    pl.cuda()

    rows = []
    for label, path in subjects:
        img = Image.open(path)
        for seed in args.seeds:
            t = time.perf_counter()
            mesh = pl.run(img, seed=seed, pipeline_type=args.type, preprocess_image=True)[0]
            bc = mesh.attrs.float()[:, 0:3]
            mx, mean = bc.max().item(), bc.mean().item()
            collapsed = mx < COLLAPSE_MAX
            rows.append({'subject': label, 'seed': seed, 'type': args.type,
                         'baseColorMean': round(mean, 4), 'baseColorMax': round(mx, 4),
                         'collapsed': collapsed, 'voxels': int(mesh.coords.shape[0]),
                         'seconds': round(time.perf_counter() - t, 1)})
            print(f'{label:<14} seed {seed:<6} mean {mean:.4f} max {mx:.4f}  '
                  f'{"COLLAPSED" if collapsed else "ok"}', flush=True)
            del mesh
            torch.cuda.empty_cache()
            with open(args.out, 'w', newline='\n') as f:
                json.dump(rows, f, indent=2)

    print('\n=== failure rate by subject ===')
    for label, _ in subjects:
        rs = [r for r in rows if r['subject'] == label]
        bad = [r for r in rs if r['collapsed']]
        print(f'{label:<14} {len(bad)}/{len(rs)} collapsed'
              + (f'  (seeds {[r["seed"] for r in bad]})' if bad else ''))
    allr = rows
    bad = [r for r in allr if r['collapsed']]
    print(f'\noverall {len(bad)}/{len(allr)} = {100.0*len(bad)/len(allr):.1f}%')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
