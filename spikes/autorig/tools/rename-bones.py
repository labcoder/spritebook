# P0-T4: rename UniRig's generic bone_N joints to Mesh2Motion/UE-style semantic
# names by matching bind-pose positions against the reference skeleton in the
# clip library. Unblocks Mesh2Motion Auto-Map (name matching) and name-based
# retargeting. bpy implementation (the deno/glTF-Transform variant hit a Deno
# npm-cache issue; bpy is the proven path in this env and auto-syncs vertex
# group names with bone renames).
#
#   python tools/rename-bones.py --rigged out/humanoid-rigged.glb \
#       --clip anim/human-base-animations.glb \
#       --out out/humanoid-rigged-named.glb --map work/humanoid-bonemap.json
import argparse
import json
import os
import sys

import bpy
from mathutils import Vector

THRESHOLD = 0.12  # normalized (unit-height) acceptance distance


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--rigged', required=True)
    p.add_argument('--clip', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--map', required=True)
    return p.parse_args()


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def find_armature(objs):
    return next((o for o in objs if o.type == 'ARMATURE'), None)


def norm_heads(arm):
    pts = {}
    for b in arm.data.bones:
        pts[b.name] = (arm.matrix_world @ b.matrix_local).translation.copy()
    ys = [p.z for p in pts.values()]  # Blender Z-up after glTF import
    xs = [p.x for p in pts.values()]
    zs = [p.y for p in pts.values()]
    h = max(1e-6, max(ys) - min(ys))
    cx = sum(xs) / len(xs)
    cz = sum(zs) / len(zs)
    y0 = min(ys)
    return {n: Vector(((p.x - cx) / h, (p.y - cz) / h, (p.z - y0) / h)) for n, p in pts.items()}


def assign(tgt, ref, mirror_x):
    cands = []
    for tn, tp0 in tgt.items():
        tp = Vector((-tp0.x, tp0.y, tp0.z)) if mirror_x else tp0
        for rn, rp in ref.items():
            cands.append(((tp - rp).length, tn, rn))
    cands.sort(key=lambda c: c[0])
    used_t, used_r, pairs, cost = set(), set(), {}, 0.0
    for d, tn, rn in cands:
        if d > THRESHOLD:
            break
        if tn in used_t or rn in used_r:
            continue
        used_t.add(tn)
        used_r.add(rn)
        pairs[tn] = (rn, d)
        cost += d
    score = (cost / len(pairs) - len(pairs) * 0.01) if pairs else 1e9
    return pairs, score


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)

    tgt_objs = import_glb(args.rigged)
    tgt_arm = find_armature(tgt_objs)
    if tgt_arm is None:
        sys.exit('ERROR: rigged glb has no armature')

    clip_objs = import_glb(args.clip)
    ref_arm = find_armature(clip_objs)
    if ref_arm is None:
        sys.exit('ERROR: clip glb has no armature')

    tgt = norm_heads(tgt_arm)
    ref = norm_heads(ref_arm)
    plain, plain_score = assign(tgt, ref, False)
    mirrored, mirrored_score = assign(tgt, ref, True)
    # near-symmetric characters tie the two hypotheses to float noise; verified
    # empirically (asymmetric stump case) that the mirror guess can invert
    # left/right - so require a clear margin before accepting the mirror
    pairs, mirror = (mirrored, True) if mirrored_score < plain_score - 0.005 else (plain, False)
    print(f'mapping: {"X-MIRRORED" if mirror else "direct"} '
          f'({len(pairs)}/{len(tgt)} joints matched; '
          f'plain={len(plain)}@{plain_score:.3f} mirrored={len(mirrored)}@{mirrored_score:.3f})')

    # remove the clip's objects entirely before renaming/exporting
    for o in clip_objs:
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)

    mapping = {}
    for tn, (rn, d) in sorted(pairs.items()):
        mapping[tn] = {'newName': rn, 'dist': round(d, 4)}
        print(f'  {tn:16s} -> {rn:20s} ({d:.3f})')
    # rename bones; Blender syncs vertex groups on bone rename only via UI ops,
    # so rename vertex groups explicitly for every mesh using this armature
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    for tn, info in mapping.items():
        for m in meshes:
            vg = m.vertex_groups.get(tn)
            if vg is not None:
                vg.name = info['newName']
        tgt_arm.data.bones[tn].name = info['newName']

    os.makedirs(os.path.dirname(args.map) or '.', exist_ok=True)
    with open(args.map, 'w') as f:
        json.dump({'mirrored': mirror, 'mapping': mapping}, f, indent=2)
    bpy.ops.export_scene.gltf(filepath=args.out, export_format='GLB', export_animations=False)
    print(f'named glb written: {args.out} · map: {args.map}')


if __name__ == '__main__':
    main()
