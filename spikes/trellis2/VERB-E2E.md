# The verb's first real run

**Date:** 2026-07-28 · RTX 3090 · `bulma-front.png` (RGBA 1254²) · trellis2-4b @ af44b45f

`spritebook gen` and `spritebook retexture` end to end through the real backend, from the CLI, for
the first time. Four results, all four rendered: `out/verb-e2e/renders/sheet_base_color.png`.

**The pipeline works. The retexture OUTPUT does not earn its place yet**, and that is the finding
that matters — not the retry rate.

## What it cost

| result | op               | seed | load s | work s | wall s | peak reserved | peak alloc | seeds tried |
| ------ | ---------------- | ---- | ------ | ------ | ------ | ------------- | ---------- | ----------- |
| r1     | gen (512)        | 7    | 82.9   | 22.5   | 120.2  | 3.01 GiB      | 2.65 GiB   | [7]         |
| r2     | retexture (512)  | 0    | 39.0   | 21.0   | 65.5   | 3.10 GiB      | 2.77 GiB   | [0]         |
| r3     | retexture (512)  | 7    | 38.5   | 16.0   | 59.8   | 3.30 GiB      | 2.76 GiB   | [7]         |
| r4     | retexture (1024) | 0    | 38.2   | 29.1   | 73.0   | 6.60 GiB      | 4.06 GiB   | [0]         |

**3.0 GiB, not 9.3.** The earlier spike measured 9.26 GiB at `1024_cascade`; the shipped default is
the 512 tier, and it costs a third of that. This runs on an 8 GB card with room to spare, which
widens the audience considerably. `minVramGb: 12` in the catalog is now conservative by 4x for the
default path — worth revisiting, with the caveat that 1024_cascade still needs the headroom.

**The load dominates, and it is paid per CLI invocation.** 82.9 s for gen (16 GB off disk), 38–39 s
for retexture (it skips the sparse-structure and shape models entirely). Against 16–29 s of actual
work. A long-lived sidecar — one process, many jobs — is worth ~40–80 s per job after the first, and
that is the strongest argument yet for the GUI holding the session open.

## The texture: everything passed the detector, and two thirds of it is worse

Saturation is the number that separates them (mean per-pixel `max(RGB) - min(RGB)` over atlas pixels
carrying colour):

|                       | atlas mean | saturation | vs source |
| --------------------- | ---------- | ---------- | --------- |
| **source cutout**     | 0.638      | **0.326**  | —         |
| **r1** generated      | 0.417      | **0.319**  | **−2%**   |
| r2 retexture @512 s0  | 0.472      | 0.130      | −60%      |
| r3 retexture @512 s7  | 0.206      | 0.095      | −71%      |
| r4 retexture @1024 s0 | 0.175      | 0.063      | −81%      |

Generation tracks the reference's saturation to within 2%. Every retexture loses most of it, and it
is plainly visible: r2 turns Bulma's green hair cyan and her pink top white; r3 is a muddy dark grey
with the silhouette barely readable; r4 is dimmer still.

**All four passed the collapse detector**, correctly — none is a constant, every mean sits inside
`0.10 .. 0.95`. The detector answers "is there content?" and it answered honestly. It was never a
quality gate and this is the first evidence of how wide the gap between those two questions is.

**Resolution is not the cause.** 1024 was the obvious suspect and it is the WORST of the three
(0.063). So `resolution: 512` stays the right default, now on quality evidence rather than only on
cost, and the desaturation is inherent to the texturing path on this mesh.

## What did NOT reproduce

**The 37.5% collapse rate.** Zero collapses in three retextures, including seed 7 — which collapsed
black in the earlier sweep on a _different_ mesh. That is consistent with the earlier conclusion
(the failure is an interaction between image, mesh and seed, not a bad seed) and n=3 is far too
small to revise the rate. The retry budget of 5 was never exercised.

It also means the question that motivated this run — "is the repaint worth the 37.5% retry rate" —
has a different answer than expected: **the retry rate is not the binding constraint. The output
quality is.** A user who retextures gets a result that costs 60 s, keeps the mesh exactly, passes
every check, and looks worse than what they had.

## What worked, and is now proven rather than argued

- **Geometry is preserved through the CLI, not just in a probe.** All four results: 199,178
  triangles, identical. `frameShift` 0.00372 (0.37%) on every retexture — well inside the 2% guard,
  and identical across seeds, which is what a deterministic preprocess should give.
- **The frame guard met a grounded canonical mesh for the first time** (the spike's input was
  origin-centred) and did not trip. The 2% tolerance holds against the input the product actually
  sends.
- **`topologyPreserved: true`** on all three retextures — the UV branch was taken, as intended.
- **Lineage is recorded.** r2, r3, r4 all carry `derivedFrom: r1`; r1 carries none. Every retexture
  repaints the ORIGINAL, never the previous repaint.
- **The receipt records the seed that ran**, and re-running seed 0 at a different resolution
  produced a different result under a new id rather than overwriting anything.
- **Both load-time patches held**: `pl.rembg_model` is `_RefusedRembg`, so the gated
  `briaai/RMBG-2.0` was never constructed across seven pipeline loads.

## Two defects this run found

1. **`--seed 0` was rejected** by every verb that takes a seed — routed through the positive-integer
   helper while the schema says non-negative and the catalog's own default seed is 0. Fixed with
   `seedFlag`, and pinned.
2. **The retexture spike's renders never happened.** `render_utils.render_frames` dispatches on type
   and refuses a bare trimesh; the probe wrapped that call in a `try/except` that printed "render
   skipped" and carried on. That spike produced numbers and no pictures, and nobody noticed.
   `render_results.py` lifts a glb into `MeshWithPbrMaterial` properly — and had we been looking at
   pictures then, the desaturation above would have been found weeks earlier.

## What to do about it

Not decided here, but the options are narrow and worth naming:

- **Condition the texture pass better.** The retexture pipeline gets the mesh and the image; the
  generation pipeline gets the image and its own shape latent. If the mesh encoding is what loses
  the colour, a stronger image conditioning weight is the knob to try.
- **Keep retexture for its actual use.** "Reroll the paint on a mesh I like" is still the honest
  feature; it just currently costs saturation. If a user's complaint is "the texture is wrong" and
  the answer is "here is a duller texture", the feature is not ready to be recommended.
- **Ship the detector as-is and add a quality signal.** Saturation-vs-source is one line of numpy
  and separates these cases cleanly. It would not have to gate — a warning naming the drop would be
  enough for a user to judge.

## Still unknown

- **One character, four results.** Whether the desaturation is bulma-specific is untested.
- **Whether `gen` is this good in general** — one image, one seed, no collapse. The 5% rate says ~1
  in 20 first attempts should fail, and this was not one of them.
- **1024_cascade end to end.** Never run through the CLI; the 9.26 GiB and the geometry evidence for
  it are still spike-only.
