"""Reference humanoid joint table for the semantic-naming pass (P0-T4 item 3).

UniRig names its predicted joints ``bone_0 .. bone_N``. Generic names break
every name-based tool downstream (Mesh2Motion's Auto-Map, retarget profiles,
`rig --edits <joint>`), so the production adapter runs a naming pass — the
`spikes/autorig/tools/rename-bones.py` idea, moved into the adapter and made
self-contained.

The reference below is the joint set of the CC0 Mesh2Motion human base rig
(`spikes/autorig/anim/human-base-animations.glb`, 66 joints, UE-style names —
the same convention the Quaternius UAL pack targets, D-013), measured once and
frozen here so the adapter does not depend on a spike asset being on disk.

Positions are UNIT-HEIGHT normalized exactly the way the spike tool normalizes,
expressed in SpriteBook's canonical axes (D-012: +Y up, +Z forward, metres,
feet at Y=0):

    x = (X - mean X) / height
    y = (Y - min Y)  / height
    z = (Z - mean Z) / height

so a match threshold is a fraction of the character's height and works the same
for a 1.7 m human and a 3.9 m giant.

This table is a HUMANOID profile. Matching a giraffe against it is supposed to
fail, and the caller records that honestly as ``semanticNames: false`` rather
than dressing four legs up in arm names.
"""

from __future__ import annotations

#: (name, unit-height normalized head position). Order is the reference rig's.
HUMANOID_REFERENCE: tuple[tuple[str, tuple[float, float, float]], ...] = (
    ("root", (-0.0, 0.0, 0.0151)),
    ("pelvis", (-0.0, 0.5552, -0.0152)),
    ("spine_01", (-0.0, 0.6362, 0.0057)),
    ("spine_02", (-0.0, 0.7107, 0.0149)),
    ("spine_03", (-0.0, 0.7962, 0.0121)),
    ("neck_01", (-0.0, 0.8941, -0.0093)),
    ("head", (-0.0, 0.95, 0.0182)),
    ("head_leaf", (-0.0, 1.0, 0.0198)),
    ("clavicle_l", (0.0114, 0.8829, 0.0584)),
    ("upperarm_l", (0.1162, 0.8726, -0.0245)),
    ("lowerarm_l", (0.2824, 0.8726, -0.0273)),
    ("hand_l", (0.4475, 0.8726, -0.0245)),
    ("index_01_l", (0.5162, 0.8713, 0.0034)),
    ("index_02_l", (0.539, 0.8713, 0.0073)),
    ("index_03_l", (0.5555, 0.8713, 0.0108)),
    ("index_04_leaf_l", (0.5698, 0.8713, 0.0136)),
    ("middle_01_l", (0.519, 0.8728, -0.0121)),
    ("middle_02_l", (0.5441, 0.8728, -0.0113)),
    ("middle_03_l", (0.5641, 0.8728, -0.009)),
    ("middle_04_leaf_l", (0.5838, 0.8728, -0.0074)),
    ("pinky_01_l", (0.514, 0.8716, -0.046)),
    ("pinky_02_l", (0.5357, 0.8716, -0.0467)),
    ("pinky_03_l", (0.5513, 0.8716, -0.0482)),
    ("pinky_04_leaf_l", (0.5675, 0.8716, -0.0497)),
    ("ring_01_l", (0.5173, 0.8726, -0.0294)),
    ("ring_02_l", (0.5394, 0.8726, -0.0302)),
    ("ring_03_l", (0.5595, 0.8726, -0.0306)),
    ("ring_04_leaf_l", (0.5774, 0.8726, -0.0306)),
    ("thumb_01_l", (0.464, 0.8587, -0.0041)),
    ("thumb_02_l", (0.4856, 0.8446, 0.0116)),
    ("thumb_03_l", (0.5053, 0.8324, 0.0244)),
    ("thumb_04_leaf_l", (0.5188, 0.8239, 0.0326)),
    ("clavicle_r", (-0.0114, 0.8829, 0.0584)),
    ("upperarm_r", (-0.1162, 0.8726, -0.0245)),
    ("lowerarm_r", (-0.2824, 0.8726, -0.0273)),
    ("hand_r", (-0.4475, 0.8726, -0.0245)),
    ("index_01_r", (-0.5162, 0.8713, 0.0034)),
    ("index_02_r", (-0.539, 0.8713, 0.0073)),
    ("index_03_r", (-0.5555, 0.8713, 0.0108)),
    ("index_04_leaf_r", (-0.5698, 0.8713, 0.0136)),
    ("middle_01_r", (-0.519, 0.8728, -0.0121)),
    ("middle_02_r", (-0.5441, 0.8728, -0.0113)),
    ("middle_03_r", (-0.5641, 0.8728, -0.009)),
    ("middle_04_leaf_r", (-0.5838, 0.8728, -0.0074)),
    ("pinky_01_r", (-0.514, 0.8716, -0.046)),
    ("pinky_02_r", (-0.5357, 0.8716, -0.0467)),
    ("pinky_03_r", (-0.5513, 0.8716, -0.0482)),
    ("pinky_04_leaf_r", (-0.5675, 0.8716, -0.0497)),
    ("ring_01_r", (-0.5173, 0.8726, -0.0294)),
    ("ring_02_r", (-0.5394, 0.8726, -0.0302)),
    ("ring_03_r", (-0.5595, 0.8726, -0.0306)),
    ("ring_04_leaf_r", (-0.5774, 0.8726, -0.0306)),
    ("thumb_01_r", (-0.464, 0.8587, -0.0041)),
    ("thumb_02_r", (-0.4856, 0.8446, 0.0116)),
    ("thumb_03_r", (-0.5053, 0.8324, 0.0244)),
    ("thumb_04_leaf_r", (-0.5188, 0.8239, 0.0326)),
    ("thigh_l", (0.0539, 0.5645, 0.016)),
    ("calf_l", (0.0539, 0.3221, 0.0143)),
    ("foot_l", (0.0539, 0.0628, -0.0066)),
    ("ball_l", (0.0539, 0.0092, 0.0837)),
    ("ball_leaf_l", (0.0539, 0.0092, 0.1315)),
    ("thigh_r", (-0.0539, 0.5645, 0.016)),
    ("calf_r", (-0.0539, 0.3221, 0.0143)),
    ("foot_r", (-0.0539, 0.0628, -0.0066)),
    ("ball_r", (-0.0539, 0.0092, 0.0837)),
    ("ball_leaf_r", (-0.0539, 0.0092, 0.1315)),
)

#: Provenance of the table above, recorded so a future edit can re-derive it.
HUMANOID_REFERENCE_SOURCE = (
    "Mesh2Motion human base rig (CC0), 66 joints, measured from "
    "spikes/autorig/anim/human-base-animations.glb"
)
