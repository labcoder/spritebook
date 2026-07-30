# Where the value goes between albedo and lit

**Date:** 2026-07-29 · RTX 3090 · a flat quad facing +Z, and bulma at 64 px

The question: every baked sheet reads darker than its reference, and the lit AOV carries about 60%
of the albedo's value. Is that the shading math working, a missing term, or a double sRGB encode?

## Answer: the shading math, exactly. Not a bug.

A quad whose normal is +Z makes the prediction closed-form. `LIGHT_DIR` is `[0.4, 0.9, 0.5]`, so

```
normalized     [0.3621, 0.8148, 0.4527]
ndl (+Z face)  0.452679
shade          AMBIENT + (1 - AMBIENT) * ndl = 0.12 + 0.88 * 0.452679 = 0.518357
lit byte       round(srgbEncode(albedoLinear * shade) * 255)
```

Measured against every hypothesis at once — the three defects predict three different numbers, so
one render distinguishes them:

| albedo (linear) | albedo byte | **lit, measured** | predicted | if double-encoded | if no ambient | if unlit |
| --------------- | ----------- | ----------------- | --------- | ----------------- | ------------- | -------- |
| 1.00            | 255         | **191**           | 191       | 224               | 179           | 255      |
| 0.50            | 128         | **139**           | 139       | 195               | 131           | 188      |
| 0.25            | 64          | **101**           | 101       | 169               | 94            | 137      |

So:

- **No double sRGB encode.** It would read 224 where 191 was measured. The shader encodes once, into
  the lit attachment only, and `contracts.ts` types that target `rgba8unorm` rather than
  `rgba8unorm-srgb`, which is what stops the hardware adding a second one.
- **No missing ambient.** There IS an ambient term and it is contributing: without it the same texel
  reads 179, twelve levels darker than measured.
- **The albedo AOV is stored LINEAR**, which is why its bytes must not be compared to lit's
  directly. The first pass at this question did exactly that and read bulma's hair as near-black in
  a pass where it is `#186a4c`.

`lighting_test.ts` now pins all of it, and its failure message names what each wrong number would
have meant.

## What actually makes the sheet dark

Two things, both ordinary:

1. **The key is mostly OVERHEAD.** Its normalized y is 0.815 against z 0.453, so a surface pointing
   at the camera — the surfaces that end up in a sprite — catches the key at ndl 0.45, not 1.0. A
   white camera-facing texel loses **26%** of its value (255 → 191).
2. **Averaged over a whole body it is worse**, because Lambert's mean over a sphere is 0.25: shade
   averages `0.12 + 0.88*0.25 = 0.34`. A mid albedo of 0.25 linear (sRGB 137) shades to sRGB **82**.
   That is a 40% drop, and it reproduces the 0.584 → 0.352 measured on bulma's real atlas.

Nothing here is broken. It is a single directional key with a low ambient floor, doing what that is.

## The rig options, measured

Four bakes of the same character, changing only the rig:

| variant      | LIGHT_DIR            | AMBIENT | mean V | p10   | p90   | below 0.15 |
| ------------ | -------------------- | ------- | ------ | ----- | ----- | ---------- |
| **shipped**  | `[0.4, 0.9, 0.5]`    | 0.12    | 0.243  | 0.047 | 0.729 | 49.9%      |
| ambient 0.30 | `[0.4, 0.9, 0.5]`    | 0.30    | 0.300  | 0.090 | 0.765 | 47.9%      |
| front key    | `[0.35, 0.55, 0.85]` | 0.12    | 0.247  | 0.047 | 0.780 | 47.6%      |
| both         | `[0.35, 0.55, 0.85]` | 0.25    | 0.297  | 0.082 | 0.816 | 47.2%      |

**Ambient is the effective knob; light DIRECTION is nearly inert.** Moving the key toward the camera
raised mean value by 2% (0.243 → 0.247) while raising ambient raised it by 23% (→ 0.300).

The reason is downstream: the adaptive palette re-normalizes. Its lightness range is 0.05..0.92
shipped and 0.05..0.90 front-lit — essentially unchanged, because median cut spreads whatever range
it is handed across the same 16 entries. A UNIFORM brightening gets quantized straight back out.
What ambient changes is the SHAPE: it lifts the dark tail (p10 0.047 → 0.090) without moving the
top, compressing the range, and that is what reads as "less dark".

Half the texels sit below V 0.15 in every variant. That is the outline plus the genuinely dark
skirt, and no rig moves it.

## Two things this turned up on the way

**The ambient constant lived in WGSL**, where no test could read it to predict what the shader would
compute. It now rides `lightDir.w` — a float already reserved and already zero — so the host owns
the whole rig and `packCamera` is its single source. Pixel-identical: every style golden is
unchanged.

**The light rig is not in the cache key.** All four variants above produced bake id `8b7302cd`,
because `CacheKeyInputs` has no lighting field; a rig change is only covered if whoever makes it
bumps `RENDERER_VERSION`. That is fine while the rig is a compile-time constant and would be a bug
the day it becomes a flag.

---

## Shipped: ambient 0.30

`AMBIENT` 0.12 → 0.30, `RENDERER_VERSION` 0.4.0 → 0.5.0.

| subject  | mean V        | p10           | outline (palette-dark) | below V 0.15     |
| -------- | ------------- | ------------- | ---------------------- | ---------------- |
| bulma    | 0.243 → 0.300 | 0.047 → 0.090 | 0.047 → 0.090          | 49.9% → 47.9%    |
| mermaid  | 0.311 → 0.371 | 0.067 → 0.110 | 0.067 → 0.110          | 37.5% → 36.1%    |
| princess | 0.286 → 0.338 | 0.094 → 0.161 | 0.094 → **0.161**      | 42.7% → **0.0%** |

**The cost is princess, and it was checked before committing.** The outline is `palette-dark`, so
lifting the floor lifts the outline: on a pastel lineless character it goes from `#180c08` to
`#291712`, outline-to-body contrast falls 2.2× → 1.7%, and she ends up with no texel below V 0.15 at
all. Still legible, and the trade is recorded in `renderer.ts` beside the constant.

### The goldens moved, but only after the AOVs did

The first refresh moved NOTHING, which is itself worth knowing: `_gen-goldens.ts` reads COMMITTED
AOV PNGs, so the style goldens are downstream of a frozen render and cannot see a lighting change at
all. Re-rendering the AOV fixtures first (`_render-aovs.ts`) is what makes a renderer change visible
to them.

| golden         | texels moved | max delta | mean V                 |
| -------------- | ------------ | --------- | ---------------------- |
| cel-2 f000     | 25.4%        | 40        | 0.498 → 0.572 (+14.8%) |
| cel-2 f003     | 25.2%        | 40        | 0.501 → 0.574 (+14.5%) |
| pixel f000     | 25.4%        | 40        | 0.516 → 0.582 (+12.7%) |
| pixel f003     | 25.2%        | 40        | 0.535 → 0.593 (+10.8%) |
| painterly f000 | 25.8%        | 12        | 0.588 → 0.630 (+7.2%)  |
| painterly f003 | 26.4%        | 37        | 0.585 → 0.630 (+7.8%)  |

The AOV fixtures' `mask` planes changed too, for an unrelated and already-committed reason: they
predated the coverage-encoding fix and still held 0/1 where the renderer now writes 0/65535.

Flicker needed no re-pin — cel-2 0.054%, pixel 0.430% (was 0.420), painterly 0.659% (was 0.689),
against budgets 0.15 / 0.55 / 1.0.

**Painterly's ceiling on the flat-shaded fixture fell 8 → 5 distinct colours**, which is the same
trade from the other side: `shade = ambient + (1-ambient)*ndl`, so the range narrows from [0.12,
1.0] to [0.30, 1.0] and faces that used to quantize apart collapse together.

## The cache gap is closed

`CacheKeyInputs.lightRigHash` hashes `{lightDir, ambient}` as DATA. Its own field rather than folded
into `cameraPresetHash` — two bakes can share a camera preset exactly and differ in every pixel, so
the camera hash cannot stand in for it. (Mirroring rides the camera hash for the opposite reason: it
really does describe how directions are produced.)

Verified on the P3 exit re-run: bake `8b7302cd` → **`674dc263`**, where before the fix four
different rigs had all produced `8b7302cd`.
