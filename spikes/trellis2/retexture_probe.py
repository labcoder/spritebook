"""
Does retexturing keep the mesh, and can we put it back where it started?

`Trellis2TexturingPipeline.run` calls `preprocess_mesh` first, which recenters
the vertices on their bbox midpoint, rescales the longest axis to 0.99999, AND
swaps axes (y = -z, z = y). `postprocess_mesh` then builds the output from those
TRANSFORMED vertices, and nothing inverts it. So a naive retexture hands back a
character rescaled to a unit box and rotated — which, against SpriteBook's
world-locked camera and feet-at-Y=0 pivot, is "every retextured character
silently bakes at the wrong size facing the wrong way".

The transform is exactly invertible from the input's own bounds, so the question
this probe answers is whether inverting it reproduces the input geometry to
float noise. That is the gate; the renders are for the paint.

  python retexture_probe.py --glb out/bulma-front-SEED7/model.glb \\
                            --image refs/bulma-front.png --seeds 7 1234 2026
"""
import argparse
import json
import os
import time

os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'
os.environ.setdefault('ATTN_BACKEND', 'xformers')

import numpy as np  # noqa: E402
import torch  # noqa: E402
import trimesh  # noqa: E402
from PIL import Image  # noqa: E402

WEIGHTS = r'C:\Users\oms10\AppData\Local\spritebook\models\trellis2-4b\af44b45f'


def as_mesh(loaded) -> trimesh.Trimesh:
    """trimesh.load on a GLB yields a Scene; take its single geometry."""
    if isinstance(loaded, trimesh.Scene):
        geoms = list(loaded.geometry.values())
        if len(geoms) != 1:
            raise SystemExit(f'expected one geometry, got {len(geoms)}')
        return geoms[0]
    return loaded


def forward_transform(vertices: np.ndarray):
    """Exactly what preprocess_mesh does, returned as its parameters.

    Recovering these from the INPUT's bounds is what makes the inverse exact —
    the pipeline derives them the same way, so there is nothing to guess.
    """
    lo, hi = vertices.min(axis=0), vertices.max(axis=0)
    center = (lo + hi) / 2
    scale = 0.99999 / (hi - lo).max()
    return center, scale


def invert(out_vertices: np.ndarray, center: np.ndarray, scale: float) -> np.ndarray:
    """Undo preprocess_mesh: axis swap back, then unscale and recenter."""
    v = out_vertices.copy()
    # forward was: tmp = y; y = -z; z = tmp   =>   inverse: y = z_out; z = -y_out
    y_out = v[:, 1].copy()
    v[:, 1] = v[:, 2]
    v[:, 2] = -y_out
    return v / scale + center


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--glb', required=True)
    ap.add_argument('--image', required=True)
    ap.add_argument('--seeds', type=int, nargs='+', default=[7, 1234, 2026])
    ap.add_argument('--resolution', type=int, default=1024, choices=[512, 1024])
    ap.add_argument('--out', default='out/retexture')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    src = as_mesh(trimesh.load(args.glb))
    has_uv = getattr(src.visual, 'uv', None) is not None
    print(f'input {args.glb}')
    print(f'  {src.vertices.shape[0]:,} verts  {src.faces.shape[0]:,} faces  uv={has_uv}')
    if not has_uv:
        print('  WARNING: no UVs -> postprocess_mesh will uv_unwrap and CHANGE the vertex count')
    center, scale = forward_transform(src.vertices)
    print(f'  bbox centre {center.round(4).tolist()}  scale {scale:.6f}')

    from trellis2.pipelines import Trellis2TexturingPipeline
    from trellis2.utils import render_utils
    import run_matrix as M
    M.patch(None)  # the transformers-5 DINOv3 attribute shim

    t0 = time.perf_counter()
    pl = Trellis2TexturingPipeline.from_pretrained(WEIGHTS, config_file='texturing_pipeline.json')
    pl.cuda()
    print(f'  pipeline loaded in {time.perf_counter() - t0:.1f}s\n')
    env = M.envmap()

    image = Image.open(args.image)
    rows = []
    for seed in args.seeds:
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        t = time.perf_counter()
        out = pl.run(src, image, seed=seed, resolution=args.resolution,
                     texture_size=2048, preprocess_image=True)
        torch.cuda.synchronize()
        secs = time.perf_counter() - t
        peak = torch.cuda.max_memory_reserved() / 1024 ** 3

        out_mesh = as_mesh(out)
        same_topology = (out_mesh.vertices.shape[0] == src.vertices.shape[0]
                         and out_mesh.faces.shape[0] == src.faces.shape[0])
        faces_identical = same_topology and np.array_equal(out_mesh.faces, src.faces)

        # THE GATE: does the inverse put every vertex back where it came from?
        if same_topology:
            restored = invert(np.asarray(out_mesh.vertices), center, scale)
            drift = float(np.abs(restored - src.vertices).max())
            raw_drift = float(np.abs(np.asarray(out_mesh.vertices) - src.vertices).max())
        else:
            drift = raw_drift = float('nan')

        base = None
        if hasattr(out_mesh.visual, 'material'):
            img = getattr(out_mesh.visual.material, 'baseColorTexture', None)
            if img is not None:
                a = np.asarray(img.convert('RGB')).astype(np.float32) / 255
                base = float(a.mean())

        print(f'seed {seed:<6} {secs:6.1f}s  peak {peak:5.2f} GiB  '
              f'topology {"SAME" if same_topology else "CHANGED"}  '
              f'faces {"identical" if faces_identical else "DIFFER"}')
        print(f'             drift after inverse {drift:.3e}   (uninverted {raw_drift:.3e})')
        print(f'             base colour mean {base if base is None else round(base, 4)}')

        d = os.path.join(args.out, f'seed{seed}')
        os.makedirs(d, exist_ok=True)
        out.export(os.path.join(d, 'textured.glb'))
        try:
            res = render_utils.render_video(out_mesh, resolution=384, num_frames=8, envmap=env)
            for i, f in enumerate(res['base_color'][:2]):
                Image.fromarray(f).save(os.path.join(d, f'basecolor_{i:02d}.png'))
        except Exception as e:  # noqa: BLE001 - a render failure must not lose the numbers
            print(f'             (render skipped: {type(e).__name__}: {str(e)[:70]})')

        rows.append({'seed': seed, 'seconds': round(secs, 1), 'peakReservedGiB': round(peak, 2),
                     'sameTopology': same_topology, 'facesIdentical': faces_identical,
                     'driftAfterInverse': drift, 'driftUninverted': raw_drift,
                     'baseColorMean': base})
        del out, out_mesh
        torch.cuda.empty_cache()

    with open(os.path.join(args.out, 'retexture.json'), 'w', newline='\n') as f:
        json.dump({'glb': args.glb, 'image': args.image, 'resolution': args.resolution,
                   'inputVerts': int(src.vertices.shape[0]),
                   'inputFaces': int(src.faces.shape[0]), 'runs': rows}, f, indent=2)

    worst = max((r['driftAfterInverse'] for r in rows if r['driftAfterInverse'] == r['driftAfterInverse']),
                default=float('nan'))
    print(f'\nworst drift after inverse across {len(rows)} seeds: {worst:.3e}')
    print('GATE: ' + ('PASS - the inverse restores the input geometry'
                      if worst < 1e-4 else 'FAIL - geometry does not round-trip'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
