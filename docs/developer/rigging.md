# Rigging and motion boundaries

SpriteBook offers two different operations: UniRig predicts a skeleton and skin weights while
preserving the source geometry; template fitting replaces the geometry with a fitted, already rigged
body. Both require motion review. See the
[user-facing rig choices](../user/guide.md#3-stage-02--rig) and
[model requirements](../user/models.md).

## Naming and skin transfer

Adapter 1.3.1 checks humanoid naming against leg, trunk and arm ancestry as well as position. Paired
arm branches are anchored at the trunk, including arms-down predictions with only one or two hand
branches. A close reference match cannot place a thigh in the spine; contradictory finger-chain
labels stay generic and produce a warning. Corrections and rejected names are recorded in
`rig/rig-run.json`. A named joint or finite, normalized weight row does not prove correct anatomy.

The CPU merge interpolates nearby samples, attenuates influence from distant bones, and smooths
weights along mesh edges with nonnegative, anchored updates. Geometric seam copies share weights;
disconnected surfaces do not exchange them. The four-influence reduction fades the discarded tail so
neighboring vertices do not suddenly lose a substantial influence when rankings cross. The former
hierarchical diffusion could produce negative parent weights; clipping those and applying a hard
influence cutoff created jagged shoulders during motion. Smoothing uses SciPy already in the
runtime, with no additional download. Neither transfer nor position hints can recover detail missing
from the model prediction. Deformation thresholds are unchanged.

Existing rigs retain their saved bytes. Rebuilding uses the updated adapter without downloading
checkpoints again. Qualification includes saved-skeleton replay and fresh GPU runs. The
[roadmap follow-through](../../future/roadmap.md#rig-correctness-and-interaction-follow-through)
records their source, hardware and remaining findings.

Animation preview and bake check mapped bone ancestry before transferring motion. Contradictory
names (for example, a thigh named `pelvis`) refuse with a request to rebuild the rig. Accepting a
deformation report records review; it does not rename bones or repair saved weights.

Joint counts vary with the prediction. GPU execution does not guarantee five separate fingers:
generic `bone_N` joints remain at rest relative to their parent during semantic animation. The Rig
screen reports mapped finger detail and branches at each named wrist; these counts are not an
anatomy certificate. Arms-down/A/T bind poses now receive a measured arm-reference alignment in core
before motion transfers, shared by preview and bake.

An arms-down generated-character qualification exposes a real limitation: a plausible skeleton can
have trouser vertices weighted to nearby hands. Two fresh seeds retain deformation findings; the
arms-raised preview exposes leakage more clearly than walking. Distance, surface-normal, visibility
and Blender heat-weight experiments did not produce a safe replacement and are not shipping. For
generated humanoids, separated limbs in an A/T pose remain the safer source; accepting a report does
not fix weight ownership. F5-T2 remains open for that repair.

Optional Blender is managed under **Tools** with its own external/portable ownership receipts. It is
separate from UniRig’s Python runtime; selecting it does not switch riggers or enable automatic
clothing repair. See [extensions](../user/extensions.md).
