# P0-T4: score predicted joint placement against the stripped factory rig.
import json
import numpy as np

for name, gt_path in (('humanoid', 'assets/humanoid-groundtruth-rig.json'),
                      ('stylized', 'assets/stylized-groundtruth-rig.json')):
    d = np.load(f'UniRig/tmp/jobs/{name}/skeleton/predict_skin.npz', allow_pickle=True)
    pred = d['joints']  # (J,3) in extract space
    gt = json.load(open(gt_path))
    gt_pos = np.array([j['worldPosition'] for j in gt['joints']] if isinstance(gt, dict) else [j['worldPosition'] for j in gt])
    # normalize both to unit height to compare shape-relative placement
    def norm(p):
        z = p[:, 1] if (p[:, 1].max() - p[:, 1].min()) > (p[:, 2].max() - p[:, 2].min()) else p[:, 2]
        h = z.max() - z.min()
        return (p - p.mean(axis=0)) / h
    P, G = norm(pred), norm(gt_pos)
    # for each GT body joint, distance to nearest predicted joint
    dists = np.linalg.norm(G[:, None, :] - P[None, :, :], axis=2).min(axis=1)
    print(f'{name}: predicted {len(P)} joints vs GT {len(G)}; '
          f'nearest-dist (unit-height): mean={dists.mean():.3f} median={np.median(dists):.3f} '
          f'p90={np.percentile(dists, 90):.3f} max={dists.max():.3f}')
