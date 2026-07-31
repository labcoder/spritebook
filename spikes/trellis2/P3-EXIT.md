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
0.344 in albedo against 0.160 in lit — the exported `atlas_lit_0.png` reads as a dark blob. (Root
cause established after this section was first written; see "Root cause" below. It is neither the
lighting nor the palette.)

**Every frame is clipped at the bottom.** All 48. The silhouette runs to y=63 of a 64 px cell while
the pivot sits at y=58, so there is geometry below the feet marker. The bake's own warning blames
the padding budget and suggests lowering `pixelsPerMeter` — which is a misdiagnosis if the real
cause is the pose or the grounding, and it sends the user to the wrong knob.

**The mask atlas is empty.** All 4096 texels of the sampled cell are alpha-1 and RGB-0. Either it
encodes something in a channel this reading misses, or it is blank; either way nothing has ever
looked at it.

**The character is ~20 px of visible silhouette in a 64 px cell**, and the manifest records
`heightM: 0.99999` — TRELLIS.2's unit-box constant. My first reading blamed `gen` running without
`--height`. That is half of it at most: passing `--height 1.65` moves nothing on screen, for the
reason in "Root cause" below.

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

## Root cause: rigging silently discards the border's normalization

The five defects above are mostly one, and it is not where I ranked it.

`SPRITEBOOK_DEBUG_RAW_LIT=1` settled the first question immediately. On the 64 px bake the pre-style
lit atlas is mean **0.415** across **167** colours; the shipped lit is mean **0.160** across **5**,
and **81% of the character is a single colour** — palette index 0, the dark outline. Re-baking the
same mesh at 128 px / 110 ppm, nothing else changed, gives pre-style 0.431 (identical) and shipped
**0.336** with the outline down to 38%. **The renderer is fine and the style stage is fine.** A 20
px character with 1–2 px limbs is mostly outline, by construction.

So why is it 20 px? Not because `gen` ran without `--height` — re-running _with_ `--height 1.65`
changes nothing on screen. The border does its job correctly and says so:

    scale | ok | Raw height 1.0037 m; scaled x1.6439 to 1.6500 m, feet at Y=0.00000

It encodes that as a parent NODE transform, and the glTF is exactly right:

    node 0  name="world"  scale=[1.6439, 1.6439, 1.6439]  translation=[0, 0.8252, 0]  children=[1]
    node 1  name="geometry_0"  mesh=0

Then `rig` skins the mesh, and node 1 gains `skin: 0`. **A skinned mesh node's transform is ignored
per the glTF spec** — the skin's joints place it — which `skinning.ts:268` implements correctly and
deliberately. The `world` node survives in the file and stops meaning anything. Every canonical
guarantee the border established, scale and feet-at-Y=0 alike, evaporates the moment a character is
rigged.

The arithmetic closes it. At local scale the mesh spans −0.5…+0.5 m; at 32 px/m about a pivot at
y=58 that is y 42…74 in a 64 px cell, clipped at 63. Measured extent: **y 43…63**.

That single defect produces the tiny sprite, the black lit pass, the 48 clipped frames, and the
`heightM: 0.99999` in the manifest. It is invisible on any unrigged mesh, which is every fixture the
suite renders.

### Fixed: the scale moved into the vertices

The border now bakes N into POSITION (with NORMAL and TANGENT taking the rotation only), so the
canonical mesh carries its scale where nothing downstream is entitled to ignore it. It declines to
bake, leaving the old node path, for an existing skin, a transformed mesh node, or morph targets -
three cases it cannot prove equivalent.

Re-run end to end with `--height 1.65`:

    POSITION min/max Y: 0.0 .. 1.65     <- the scale is in the DATA
    nodes: world(scale=None), geometry_0(scale=None)

|                           | before      | after        |
| ------------------------- | ----------- | ------------ |
| silhouette extent in cell | y 44..63    | **y 11..60** |
| clipped frames            | **48 / 48** | **0**        |
| covered texels            | 170         | **569**      |

**`silhouette-clipped` no longer fires.** Before, the legs were simply absent - the character was
cut off at the waist on every frame. After, the whole figure is present and grounded.

What did NOT change is the darkness: the shipped lit is mean 0.137 with 67% of the character still a
single palette entry. At 49 px a slim character's limbs are 2-3 px wide and an outline claims most
of them - the same effect measured at 128 px drops it to 38%. That is a style question (outline
width against cell size for slim subjects), not the bug that was fixed here.

## The chain after the fixes, in one run

`p3_exit.sh` (now defaulting to the `--height 1.65` workspace): pick 1 s, rig 85 s, bake 4 s, export
1 s. No `silhouette-clipped`, no scale warning, and the new `rig-unaccepted` warn fires exactly
where silence used to be. The composite against the reference is
`out/p3-exit/final_vs_reference.png`: complete figure, grounded, pixel-8 at the half-pixel line.

**What one look shows is now quality, not defects.** The pink top, skirt and socks read; the hair
bakes muddy green-brown against a teal reference and the face is texture noise at 64 px. Those are
generation-fidelity limits (the canonical mesh's texture is what it is), not pipeline bugs — the
albedo matches the canonical texture it was given.

**A seam the re-run exposed, recorded not fixed:** the outline comparison baked this workspace with
`--style pixel-8-both`, D-029's writeback recorded that id in the character's look, and the
scaffolding preset was then deleted — so a flagless bake refused with _unknown style "pixel-8-both"
(from the character's look)_. The error is honest and one `--style pixel-8` bake repairs it.
Pre-release this is fine; post-release, deleting a preset id is a migration.

## Verdict

**The exit is not met.** Not on time — time is comfortable — but on output: the artifact a user
would import into Godot is a dark, clipped, metre-tall blob, produced from an unaccepted rig, on a
path that has an undeclared dependency on one machine's cache.

Every one of these was invisible while the chain ran on `fixture-gen`.

Ranked by what blocks the exit:

1. ~~The lit pass ships black~~ — SYMPTOM. Root cause below.
2. ~~UniRig's config is not in the registry~~ — **FIXED**: the catalog ships it, sha256-pinned at a
   pinned revision, and the `llm-config-from-cache` warning is gone.
3. ~~48/48 frames clipped~~ — SYMPTOM of the same root cause. The warning's advice was also wrong
   and now names both possible causes.
4. ~~`bake` accepts a rig whose own deform check rejected it~~ — **FIXED as a loud warn**:
   `rig-unaccepted` fires at bake time, naming the rig and the repair verbs. Not a refusal, for a
   reason the message states: no verb can set `accepted: true` yet, so refusing would dead-end every
   rigged character.
5. ~~`gen` without `--height` yields an arbitrary scale~~ — it now WARNS, naming the measured height
   and the flag. But that was never the whole story: declaring the height does not help either.

**The one that matters: rigging discards the border's normalization.** Everything struck through
above except the registry fix is that bug wearing different clothes.

---

# Re-measured 2026-07-29, after the two output blockers

Same chain, same workspace (`bulma-fixed`, the one generated under the vertex-baking border).

| stage  | wall  | note                                                       |
| ------ | ----- | ---------------------------------------------------------- |
| pick   | 1 s   |                                                            |
| rig    | 122 s | UniRig, 52 joints, 9 flagged (was 37 before the seam rule) |
| bake   | 5 s   | 48 frames, 8 directions, **no QA flags**                   |
| export | 1 s   | godot                                                      |

## Blocker 1: the mask atlas was never empty

This report claimed "all 4096 texels of the sampled cell are alpha-1 and RGB-0". That reading was
wrong. `atlas_mask_0.png` is a 1-channel 16-bit gray PNG, and the same file measures **8.68% covered
(22,760 of 262,144 texels)**. Nothing was broken.

What WAS wrong is that the coverage shader writes a constant 1 and the encoder stored that 1
verbatim, so a correct mask page rendered at 0.002% brightness — a black rectangle in any viewer,
and indistinguishable from the failure it looked like. `encodeAov` had no test at all, and the one
render test that covered this asserted `v === 1`: it agreed with the encoder, and neither agreed
with anyone opening the file. Coverage is now written at full scale, and the same 22,760 texels come
back as 65535.

## Blocker 2: the clipping was grounding, and it was already fixed

The "all 48 frames clipped" measurement came from the `bulma-scaled` workspace. Measured now, that
is not a framing fault:

| workspace              | skinned rest Y      | on screen   | bottom edge      |
| ---------------------- | ------------------- | ----------- | ---------------- |
| bulma-scaled (pre-fix) | **[-0.502, 0.502]** | rows 43..63 | **48/48 frames** |
| bulma-fixed (post-fix) | [0.000, 1.650]      | rows 10..60 | 0/48             |

`bulma-scaled` was standing half underground: rigging had discarded the border's placement, leaving
the body centred on the origin, 0.502 m = **16 px below the pivot row** at 32 px/m. That is the same
defect fixed in `b0e212e`, so the clipping went with it — the current bake raises no flag at all.

Not the pose, and not the framing. `camera.ts` pins world Y=0 onto row `cellPx.h - paddingPx` by
construction and the model bounds never enter the vertical solve, so the framing was doing exactly
what it promised. The residual 2 px of overshoot on the fixed workspace is the camera TILT: a ground
point on the near edge of a 0.379 m-deep footprint projects `halfDepth·sin(30°)·32` ≈ 3 px below the
anchor, which is what the 6 px padding is for.

**The warning was the real defect.** It sent the user to `pixelsPerMeter`, which would have stopped
the clipping by making a half-buried character smaller. It now splits by edge: bottom on a
feet-baseline preset names grounding and `rig --feet-ground`; every other edge keeps the camera
advice, because there it is right; a center pivot keeps it for the bottom too, since it does not pin
Y=0 and the grounding inference is not available.

### And the knob it names did not work

`rig --feet-ground` composed its translation onto the mesh NODE, and these fixes run immediately
before `applyRig` attaches a skin — after which the glTF spec says the node's transform no longer
places the mesh. Measured: a body 1 m underground came back with a node matrix of +1 and vertices
still at -1. Third instance of this defect class. Orientation fixes now bake into vertex data, and
the test reads vertices rather than `worldPositions`, which is why the existing suite passed
throughout.

## What the sheet looks like

Full-height, in frame, recognisably the reference: pink top, dark skirt, skin tones, 8 directions ×
6 frames. Flicker 0.19%, palette of 8. **This is a sheet worth importing**, against the ~20 px
near-black blob this report opened with.

The honest gap is colour. The palette
(`#030414 #091a28 #3b1428 #642c47 #484937 #98595a #c3736e #e3bbb0`) has no teal and no blue: the
hair and skirt land as near-black and dark plum. That is the LIT pass, and it is the same
lit-vs-albedo gap this report measured at the start (albedo 0.344 / lit 0.160) — narrowed but not
closed by the scale fix. It is a look problem now, not a broken-pipeline problem, and it belongs to
P4.

> **Superseded (2026-07-31):** the colour gap did NOT go to P4 — it was diagnosed and closed inside
> P3 by the quality waves (spikes/trellis2/QUALITY-AUDIT.md and the A/B/C-wave records beside it):
> ambient 0.12 → 0.30, `pixel` at 16 colours, texture guidance 3.5/0.2, the Oklab colour-match pass
> (λ 0.5), source-image reprojection default-on in `pick`, and camera-frame lighting. The teal and
> the blue are in the shipped palette; docs/internal/roadmap/p3.md carries the close note.

## Still open

- The colour gap above.
- `RigState.accepted` is false, so the bake warns loudly and proceeds. 9 joints flagged, down from
  37 — the seam rule did that, not a better rig.
