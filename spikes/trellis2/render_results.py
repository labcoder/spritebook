"""
Render every GenerationResult in a workspace, side by side, for eyeball review.

The point is a picture a human can judge: the collapse detector answers "is this
a constant?" and nothing else. A texture can pass the mean test and still be
mud, and only looking tells you that.

Renders each result's CANONICAL model.glb — the bytes the receipt pins and every
downstream stage consumes, not the raw backend output — from a fixed set of
yaws, so the same row across results is the same camera and differences are the
paint rather than the pose.

  uv run --project sidecar python spikes/trellis2/render_results.py \
      --workspace spikes/trellis2/out/verb-e2e/bulma --out out/verb-e2e/renders
"""
import argparse
import json
import os
from pathlib import Path

os.environ.setdefault('ATTN_BACKEND', 'xformers')
os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'

import numpy as np  # noqa: E402
import torch  # noqa: E402
import trimesh  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

# the checkout resolution the adapters use, so this script and the adapter
# cannot disagree about where trellis2 lives
from spritebook_sidecar.adapters.trellis2 import _ensure_importable  # noqa: E402

VIEWS = [0.0, 0.25, 0.5, 0.75]  # front, side, back, other side (fractions of a turn)
LABEL_H = 26


def as_mesh(loaded):
    if isinstance(loaded, trimesh.Scene):
        geoms = list(loaded.geometry.values())
        if len(geoms) != 1:
            raise SystemExit(f'expected one geometry, got {len(geoms)}')
        return geoms[0]
    return loaded


def to_pbr(mesh, device='cuda'):
    """trimesh -> the renderer's MeshWithPbrMaterial.

    `render_frames` dispatches on TYPE and refuses a bare trimesh, so a glb has
    to be lifted into the backend's own representation before it can be drawn.
    (The retexture spike wrapped its render call in a try/except that printed
    "render skipped" — which is why that spike produced numbers and no pictures.
    This is the part that was missing.)

    Vertices are normalised into [-0.5, 0.5] the way the training loader does,
    so the fixed camera frames any character regardless of its world scale.
    UVs are expanded to per-face-corner because that is the layout the renderer
    indexes, and V is flipped for the glTF texture convention.
    """
    from trellis2.representations.mesh.base import (
        MeshWithPbrMaterial, PbrMaterial, Texture,
    )

    v = torch.as_tensor(np.asarray(mesh.vertices), dtype=torch.float32, device=device)
    f = torch.as_tensor(np.asarray(mesh.faces), dtype=torch.int64, device=device)

    # CANONICAL (glTF, Y-up, feet at Y=0) -> the renderer's frame, which is the
    # one the backend's own meshes live in. `postprocess_mesh` leaves glb space
    # as (x, z_r, -y_r), so the inverse is y_r = -z, z_r = y. Without this every
    # character renders lying on its back, upside down — the meshes are fine,
    # the camera is simply somewhere else.
    v = torch.stack([v[:, 0], -v[:, 2], v[:, 1]], dim=-1)

    lo, hi = v.min(dim=0)[0], v.max(dim=0)[0]
    v = (v - (lo + hi) / 2) * (0.99999 / (hi - lo).max())

    uv = getattr(mesh.visual, 'uv', None)
    if uv is None:
        raise SystemExit('mesh has no UVs; nothing to sample a texture with')
    uv_t = torch.as_tensor(np.asarray(uv), dtype=torch.float32, device=device)
    uv_t = torch.stack([uv_t[..., 0], 1.0 - uv_t[..., 1]], dim=-1)
    uv_coords = uv_t[f]  # [F, 3, 2]

    img = mesh.visual.material.baseColorTexture
    tex = torch.as_tensor(
        np.asarray(img.convert('RGB'), dtype=np.float32) / 255.0, device=device
    )
    material = PbrMaterial(
        base_color_texture=Texture(tex),
        metallic_factor=0.0,
        roughness_factor=0.9,
    )
    # `.to()` at the end, not device= on each tensor: PbrMaterial builds
    # `base_color_factor` on the CPU in its own constructor, and the renderer
    # multiplies it against a CUDA tensor.
    return MeshWithPbrMaterial(
        vertices=v,
        faces=f,
        material_ids=torch.zeros(f.shape[0], dtype=torch.int64, device=device),
        uv_coords=uv_coords,
        materials=[material],
    ).to(device)


def envmap():
    """A gradient sky. OpenCV 5 dropped EXR decode, so the bundled HDRIs are
    unreadable; a synthetic one costs nothing and removes an image codec from
    the dependency list."""
    from trellis2.renderers import EnvMap
    h, w = 256, 512
    t = torch.linspace(1.0, 0.0, h, device='cuda').view(h, 1, 1)
    sky = torch.tensor([0.55, 0.68, 0.95], device='cuda').view(1, 1, 3)
    ground = torch.tensor([0.28, 0.26, 0.24], device='cuda').view(1, 1, 3)
    return EnvMap(((sky * t + ground * (1 - t)) * 1.15).expand(h, w, 3).contiguous())


def render_views(mesh, env, resolution: int):
    """One image per yaw in VIEWS, base colour AND lit."""
    from trellis2.utils import render_utils
    from trellis2.utils.render_utils import yaw_pitch_r_fov_to_extrinsics_intrinsics

    yaws = [np.pi / 2 - 2 * np.pi * v for v in VIEWS]
    pitches = [0.25] * len(VIEWS)
    extr, intr = yaw_pitch_r_fov_to_extrinsics_intrinsics(yaws, pitches, 2, 40)
    return render_utils.render_frames(
        mesh, extr, intr,
        {'resolution': resolution, 'bg_color': (1, 1, 1)},
        verbose=False, envmap=env,
    )


def label(img: Image.Image, text: str) -> Image.Image:
    """A caption strip under a tile. Unlabelled comparison sheets are how you
    end up arguing about which column was which."""
    out = Image.new('RGB', (img.width, img.height + LABEL_H), (255, 255, 255))
    out.paste(img, (0, 0))
    ImageDraw.Draw(out).text((6, img.height + 6), text, fill=(20, 20, 20))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--workspace', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--resolution', type=int, default=384)
    ap.add_argument('--aov', default='base_color', choices=['base_color', 'color'])
    args = ap.parse_args()

    _ensure_importable()
    ws = Path(args.workspace)
    manifest = json.loads((ws / 'character.json').read_text(encoding='utf-8'))
    results = manifest['generation']['results']
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    env = envmap()
    rows = []
    for r in results:
        model = ws / 'results' / r['id'] / 'model.glb'
        if not model.is_file():
            print(f'skip {r["id"]}: no canonical model')
            continue
        mesh = to_pbr(as_mesh(trimesh.load(str(model), process=False)))
        frames = render_views(mesh, env, args.resolution)
        aov = args.aov if args.aov in frames else next(iter(frames))

        meta_path = ws / 'results' / r['id'] / 'gen-meta.json'
        meta = json.loads(meta_path.read_text(encoding='utf-8')) if meta_path.is_file() else {}
        parent = r.get('derivedFrom')
        caption = (
            f'{r["id"]}  seed {r["seed"]}  '
            + (f'retexture of {parent}' if parent else 'generated')
            + f'  |  {meta.get("runSeconds", "?")}s  {meta.get("peakVramReservedGb", "?")}GiB'
        )

        tiles = [Image.fromarray(f) for f in frames[aov][:len(VIEWS)]]
        row = Image.new('RGB', (sum(t.width for t in tiles), tiles[0].height), (255, 255, 255))
        x = 0
        for t in tiles:
            row.paste(t, (x, 0))
            x += t.width
        for i, t in enumerate(tiles):
            t.save(out_dir / f'{r["id"]}_view{i}.png')
        rows.append(label(row, caption))
        print(f'{r["id"]}: rendered {len(tiles)} views ({aov})')
        del mesh
        torch.cuda.empty_cache()

    if not rows:
        raise SystemExit('nothing rendered')
    sheet = Image.new(
        'RGB',
        (max(r.width for r in rows), sum(r.height for r in rows)),
        (255, 255, 255),
    )
    y = 0
    for r in rows:
        sheet.paste(r, (0, y))
        y += r.height
    sheet_path = out_dir / f'sheet_{args.aov}.png'
    sheet.save(sheet_path)
    print(f'\nsheet: {sheet_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
