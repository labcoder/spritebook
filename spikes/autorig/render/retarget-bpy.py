# P0-T4: quick position-based retarget (bpy 4.2 as pip module).
#
#   python render/retarget-bpy.py --rigged out/humanoid-rigged.glb \
#       --clip anim/human-base-animations.glb --clip-name Walk \
#       --output out/humanoid-anim.glb --frames 24
#
# Method: both the UniRig-rigged character and the clip's mannequin are T-pose
# humanoids. Map each TARGET (predicted) bone to the nearest SOURCE (clip) bone
# in height-normalized rest space, then bake per-frame world-space rotation
# deltas (pose @ rest^-1) from source onto target rest matrices. No bone-name
# assumptions about UniRig output; the clip skeleton is UE-style named.
# Untested assumptions:
#  A1 glTF importer yields armatures with bones in rest at frame<start
#  A2 pose_bone.matrix assignment in armature space + per-bone depsgraph update
#     is stable when applied in hierarchy order
#  A3 source clip actions are on the armature object (action per clip, NLA or
#     active action); we locate by action name substring
#  A4 root motion: source root world delta translation applied to target root,
#     scaled by height ratio
import argparse
import math
import sys

import bpy
from mathutils import Matrix, Vector


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--rigged', required=True)
    p.add_argument('--clip', required=True)
    p.add_argument('--clip-name', default='Walk')
    p.add_argument('--output', required=True)
    p.add_argument('--frames', type=int, default=24)
    return p.parse_args()


def reset_blend():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def find_armature(objs):
    for o in objs:
        if o.type == 'ARMATURE':
            return o
    return None


def bone_rest_world(arm_obj, bone_name):
    b = arm_obj.data.bones[bone_name]
    return arm_obj.matrix_world @ b.matrix_local


def bone_pose_world(arm_obj, pose_bone):
    return arm_obj.matrix_world @ pose_bone.matrix


def skeleton_height_and_base(arm_obj):
    zs = []
    for b in arm_obj.data.bones:
        head = (arm_obj.matrix_world @ b.matrix_local).translation
        zs.append(head.z)
    return (max(zs) - min(zs)) or 1.0, min(zs)


def normalized_heads(arm_obj):
    height, base = skeleton_height_and_base(arm_obj)
    out = {}
    for b in arm_obj.data.bones:
        head = (arm_obj.matrix_world @ b.matrix_local).translation
        out[b.name] = Vector(((head.x) / height, (head.y) / height, (head.z - base) / height))
    return out


def main():
    args = parse_args()
    reset_blend()

    tgt_objs = import_glb(args.rigged)
    tgt_arm = find_armature(tgt_objs)
    if tgt_arm is None:
        sys.exit('ERROR: rigged glb has no armature')

    src_objs = import_glb(args.clip)
    src_arm = find_armature(src_objs)
    if src_arm is None:
        sys.exit('ERROR: clip glb has no armature')
    # drop the clip's mannequin meshes - we only need its skeleton+actions
    for o in src_objs:
        if o.type == 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)

    # pick the action
    action = None
    for a in bpy.data.actions:
        if args.clip_name.lower() == a.name.lower():
            action = a
            break
    if action is None:
        # among substring matches prefer the SHORTEST action name, so
        # --clip-name Walk picks "Walk_Armature.001" over "Crouch_Walk_..."
        matches = [a for a in bpy.data.actions if args.clip_name.lower() in a.name.lower()]
        if matches:
            action = min(matches, key=lambda a: len(a.name))
    if action is None:
        names = sorted(a.name for a in bpy.data.actions)
        sys.exit(f'ERROR: clip "{args.clip_name}" not found. available: {names[:40]}...')
    src_arm.animation_data_create()
    src_arm.animation_data.action = action
    f0, f1 = action.frame_range

    # rest data (before posing)
    tgt_rest = {b.name: bone_rest_world(tgt_arm, b.name).copy() for b in tgt_arm.data.bones}
    src_rest = {b.name: bone_rest_world(src_arm, b.name).copy() for b in src_arm.data.bones}
    tgt_norm = normalized_heads(tgt_arm)
    src_norm = normalized_heads(src_arm)
    tgt_h, _ = skeleton_height_and_base(tgt_arm)
    src_h, _ = skeleton_height_and_base(src_arm)

    # name-first mapping (works when the rig was renamed via tools/rename-bones.py
    # — exact matches carry correct left/right sides); nearest-position fallback
    # for bones that kept generic names
    mapping = {}
    src_names = set(src_norm.keys())
    for tname, tpos in tgt_norm.items():
        if tname in src_names:
            mapping[tname] = (tname, 0.0)
            continue
        best, bestd = None, 1e9
        for sname, spos in src_norm.items():
            d = (tpos - spos).length
            if d < bestd:
                best, bestd = sname, d
        mapping[tname] = (best, bestd)
    named = sum(1 for _, (s, d) in mapping.items() if d == 0.0)
    print(f'bone mapping: {named} by name, {len(mapping) - named} by position:')
    for tname, (sname, d) in sorted(mapping.items()):
        print(f'  {tname:24s} <- {sname:20s} {"NAME" if d == 0.0 else f"{d:.3f}"}')

    # hierarchy order: parents before children
    order = []

    def walk(bone):
        order.append(bone.name)
        for c in bone.children:
            walk(c)

    for b in tgt_arm.data.bones:
        if b.parent is None:
            walk(b)

    # find source + target roots for root motion (lowest bone with children)
    src_root = next((b.name for b in src_arm.data.bones if b.parent is None), None)
    tgt_root = next((b.name for b in tgt_arm.data.bones if b.parent is None), None)

    scene = bpy.context.scene
    n = max(2, args.frames)
    scene.frame_start = 0
    scene.frame_end = n - 1
    tgt_arm.animation_data_create()
    bake_action = bpy.data.actions.new('RetargetBake')
    tgt_arm.animation_data.action = bake_action

    needed_src = {sname for sname, _ in mapping.values()}
    if src_root is not None:
        needed_src.add(src_root)
    needed_src = sorted(needed_src)

    # facing correction: world-space deltas only transfer correctly if both
    # skeletons face the same way; otherwise knees hinge backward ("ostrich
    # legs"). Detect forward via foot->toe(ball) and conjugate deltas by the
    # yaw difference.
    def facing_yaw(arm, rest):
        for foot, ball in (('foot_l', 'ball_l'), ('foot_r', 'ball_r')):
            if foot in rest and ball in rest:
                f = rest[ball].translation - rest[foot].translation
                if f.length > 1e-6:
                    return math.atan2(f.x, f.y)
        return None

    yaw_s = facing_yaw(src_arm, src_rest)
    yaw_t = facing_yaw(tgt_arm, tgt_rest)
    if yaw_s is None or yaw_t is None:
        # assets in this spike share glTF orientation conventions: the measured
        # humanoid correction is ~0 deg, so skeletons lacking named feet get none
        yaw_fix = 0.0
        print('facing: foot/ball names missing on one side; assuming 0 deg correction')
    else:
        yaw_fix = yaw_t - yaw_s
        print(f'facing: source yaw {math.degrees(yaw_s):.0f} deg, target yaw {math.degrees(yaw_t):.0f} deg '
              f'-> conjugating deltas by {math.degrees(yaw_fix):.0f} deg')
    R_fix = Matrix.Rotation(yaw_fix, 4, 'Z')
    R_fix_inv = R_fix.inverted()
    for i in range(n):
        f = f0 + (f1 - f0) * (i / (n - 1))
        scene.frame_set(int(round(f)))
        # SNAPSHOT all source world poses BEFORE mutating the target: assigning
        # pose matrices + view_layer.update() invalidates the depsgraph, and a
        # stale evaluated source silently reads back as rest pose (frozen bake)
        deps = bpy.context.evaluated_depsgraph_get()
        src_eval = src_arm.evaluated_get(deps)
        src_pose_w = {}
        for sname in needed_src:
            spb = src_eval.pose.bones[sname]
            src_pose_w[sname] = (src_eval.matrix_world @ spb.matrix).copy()

        # transfer WORLD ORIENTATION per bone (conjugated into the target's
        # facing frame); the head position rides the already-updated parent
        # chain — rotating about rest heads + absolute placement detaches
        # children and produced rigid straight legs (zero knee flexion)
        inv_arm = tgt_arm.matrix_world.inverted()
        for tname in order:
            sname, _d = mapping[tname]
            delta = src_pose_w[sname] @ src_rest[sname].inverted()
            delta_rot = R_fix @ delta.to_quaternion().to_matrix().to_4x4() @ R_fix_inv
            t_rest_rot = tgt_rest[tname].to_quaternion().to_matrix().to_4x4()
            desired_rot_w = delta_rot @ t_rest_rot

            bpy.context.view_layer.update()  # parents already posed this frame
            tpb = tgt_arm.pose.bones[tname]
            cur_w = tgt_arm.matrix_world @ tpb.matrix
            desired_w = Matrix.Translation(cur_w.translation) @ desired_rot_w
            if tname == tgt_root and src_root is not None:
                # root motion: translate by source root world delta, scaled
                dt = (src_pose_w[src_root].translation - src_rest[src_root].translation) * (tgt_h / src_h)
                desired_w = Matrix.Translation(R_fix @ dt) @ Matrix.Translation(tgt_rest[tname].translation) @ desired_rot_w
            tpb.matrix = inv_arm @ desired_w

        bpy.context.view_layer.update()
        for tname in order:
            tpb = tgt_arm.pose.bones[tname]
            tpb.keyframe_insert('rotation_quaternion', frame=i)
            if tname == tgt_root:
                tpb.keyframe_insert('location', frame=i)

    # remove source armature and purge every action except the bake, so the
    # exported glb contains exactly one animation with a predictable name
    bpy.data.objects.remove(src_arm, do_unlink=True)
    src_clip_name = action.name  # capture before purge invalidates the RNA
    bake_action.name = 'RetargetBake'
    for a in list(bpy.data.actions):
        if a is not bake_action:
            bpy.data.actions.remove(a)
    bpy.ops.export_scene.gltf(filepath=args.output, export_format='GLB', export_animations=True)
    print(f'retargeted glb written: {args.output} (source clip {src_clip_name}, {n} frames)')


if __name__ == '__main__':
    main()
