# Importer fixture: rigged-cube.fbx - a 1 m cube skinned to a 2-bone chain.
# Generated ONCE with bpy 4.2 (pip module) and checked in; FBX embeds
# timestamps/GUIDs so the file itself is not re-generation-stable, but the
# importer's output from this fixed file must be.
#
#   uv venv <tmp>/.venv && uv pip install --python <tmp>/.venv bpy==4.2
#   <tmp>/.venv/Scripts/python.exe packages/importer/fixtures/_generate-fbx.py
import os

import bpy

bpy.ops.wm.read_factory_settings(use_empty=True)

# armature: root (0..0.5) -> tip (0.5..1.0)
arm_data = bpy.data.armatures.new('Armature')
arm_obj = bpy.data.objects.new('Armature', arm_data)
bpy.context.scene.collection.objects.link(arm_obj)
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.mode_set(mode='EDIT')
root = arm_data.edit_bones.new('root')
root.head = (0, 0, 0)
root.tail = (0, 0, 0.5)
tip = arm_data.edit_bones.new('tip')
tip.head = (0, 0, 0.5)
tip.tail = (0, 0, 1.0)
tip.parent = root
bpy.ops.object.mode_set(mode='OBJECT')

# cube 1 m tall resting on the ground (Blender Z-up; exporter converts)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
cube = bpy.context.active_object
cube.name = 'RiggedCube'

# deterministic weights: lower verts -> root, upper verts -> tip
vg_root = cube.vertex_groups.new(name='root')
vg_tip = cube.vertex_groups.new(name='tip')
for v in cube.data.vertices:
    if v.co.z < 0:
        vg_root.add([v.index], 1.0, 'REPLACE')
    else:
        vg_tip.add([v.index], 1.0, 'REPLACE')

mod = cube.modifiers.new(name='Armature', type='ARMATURE')
mod.object = arm_obj
cube.parent = arm_obj

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rigged-cube.fbx')
bpy.ops.export_scene.fbx(
    filepath=out,
    use_selection=False,
    add_leaf_bones=False,
    bake_anim=False,
    path_mode='STRIP',
)
print('wrote', out)
