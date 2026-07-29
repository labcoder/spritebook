# P3 exit measurement, on a real generated character

**Date:** 2026-07-28 · RTX 3090 · bulma, TRELLIS.2-4B mesh (199,178 tris), UniRig Track B

The exit criterion is "**≤30 min image→engine-imported character**, measured end to end". Every
previous claim on that number used `fixture-gen`, because until this session
`gen --model trellis2-4b` never reached its adapter — the catalog id and the adapter id have never
matched. This is the first run of the chain on a mesh a real backend produced.

## Timings: 5.6 minutes against a 30-minute budget

| stage     | wall         | note                                     |
| --------- | ------------ | ---------------------------------------- |
| gen (r1)  | 120 s        | recorded earlier; seed 7, 512 tier       |
| retexture | 91 s         | r5, ladder climbed past two chrome seeds |
| pick      | 1 s          |                                          |
| **rig**   | 119 s        | UniRig, 40 joints                        |
| bake      | 4 s          | 48 frames, 8 directions                  |
| export    | 1 s          | godot                                    |
| **total** | **~5.6 min** | **19% of the budget**                    |

Time is not the problem and never was. The pipeline is roughly 5× faster than it needs to be, even
paying a ~35 s model load on each of three separate CLI invocations.

## The output is not usable, and that IS the finding

**The albedo pass is correct.** Pink top, green hair, blue skirt, skin tones — the character is
recognisably the reference. Generation, retexture and the border all did their jobs.

**The lit pass, which is the one the exporter ships, is a near-black silhouette.** Mean base colour
0.344 in albedo against 0.160 in lit — the exported `atlas_lit_0.png` reads as a dark blob. Root
cause not established: it is either the render's lighting or the style stage's palette, and telling
them apart needs a pre-style AOV that the bake does not currently keep.

**Every frame is clipped at the bottom.** All 48. The silhouette runs to y=63 of a 64 px cell while
the pivot sits at y=58, so there is geometry below the feet marker. The bake's own warning blames
the padding budget and suggests lowering `pixelsPerMeter` — which is a misdiagnosis if the real
cause is the pose or the grounding, and it sends the user to the wrong knob.

**The mask atlas is empty.** All 4096 texels of the sampled cell are alpha-1 and RGB-0. Either it
encodes something in a channel this reading misses, or it is blank; either way nothing has ever
looked at it.

**The character is ~20 px of visible silhouette in a 64 px cell.** The canonical mesh measures X
0.890 / **Y 1.000** / Z 0.229 m, because `gen` ran without `--height` and the border only rescales
when a `declaredHeightM` is supplied — so the mesh kept TRELLIS.2's unit-box normalisation. A 1.0
m-tall character is a metre-tall character: correct arithmetic against a camera in px/m, and almost
certainly not what anyone wants from a photo of an adult. Nothing warned.

## The rig is flagged and the bake ran anyway

    warn [deform-flagged]: 37 joints look wrong under test poses:
      spine_02, spine_03, neck_01, head, head_leaf, clavicle_l (excessive-stretch)

`RigState.accepted` is **false** — and `bake` proceeded regardless. On a generated 200 k-face mesh
UniRig placed 40 joints and 37 of them fail the deform check. Whether the bake should refuse an
unaccepted rig is a product decision, but shipping sprites off one silently is not defensible.

## A portability defect that breaks the exit criterion by its own terms

    warn [llm-config-from-cache]: The registry does not ship UniRig's opt-350m architecture
    config, so it is being read from the local Hugging Face cache. Nothing is downloaded
    (HF_HUB_OFFLINE=1), but this machine happens to have it cached and another machine may not.

The criterion says "**on a fresh machine transcript**". A fresh machine has no such cache, so `rig`
would fail there. The 5.6-minute number is real for this machine and unproven for the one the exit
actually names.

## Verdict

**The exit is not met.** Not on time — time is comfortable — but on output: the artifact a user
would import into Godot is a dark, clipped, metre-tall blob, produced from an unaccepted rig, on a
path that has an undeclared dependency on one machine's cache.

Every one of these was invisible while the chain ran on `fixture-gen`.

Ranked by what blocks the exit:

1. **The lit pass ships black** while albedo is correct — the user-visible defect.
2. **UniRig's config is not in the registry** — breaks "fresh machine" outright.
3. **48/48 frames clipped**, with a warning that names the wrong cause.
4. **`bake` accepts a rig whose own deform check rejected it.**
5. **`gen` without `--height` yields an arbitrary scale**, silently.
