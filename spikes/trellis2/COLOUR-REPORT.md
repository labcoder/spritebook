# Where bulma's colour goes

**Date:** 2026-07-29 · bulma-fixed, `standard-30` + `pixel-8`, 64 px cells, 48 frames

The question: the 8-colour sheet lands hair and skirt as near-black. Is the lit pass losing the hue,
or is the palette dropping it during selection?

## Answer: palette selection. The lit pass has the colour.

Measured over the 26,839 covered texels of the 1x atlas cells, with the albedo converted out of
LINEAR into sRGB first — `render/contracts.ts` stores albedo linear and lit already sRGB-encoded in
the shader, so comparing them raw is a category error and makes albedo look far darker than it is.

| stage               | distinct colours | mean saturation | mean value |
| ------------------- | ---------------- | --------------- | ---------- |
| albedo (→sRGB)      | 5,118            | 0.598           | 0.584      |
| raw lit (pre-style) | **9,895**        | 0.637           | 0.352      |
| shipped (8 colours) | 8                | 0.683           | 0.229      |

Segmented by RAW LIT hue — the signal `buildPalette` is actually fed (`pipeline.ts` builds from
`aov.lit`, pre-composite):

| hue bin               | texels | albedo→sRGB | raw lit   | shipped @8 |
| --------------------- | ------ | ----------- | --------- | ---------- |
| spring 150–180 (hair) | 2,500  | `#186a4c`   | `#0b422e` | `#212628`  |
| blue 240–270 (skirt)  | 3,754  | `#17113a`   | `#0d0a28` | `#060b1b`  |
| rose 330–360 (top)    | 5,479  | `#cb4661`   | `#80293b` | `#532c39`  |
| red 0–30 (skin)       | 5,448  | `#ef9984`   | `#8c584c` | `#463336`  |

The hair's green and the skirt's navy are BOTH present in the raw lit. They are not present in the
shipped sheet. So the loss happens between those two, which is quantization.

**Why the palette spends its budget elsewhere.** The 8 entries are
`#030414 #091a28 #3b1428 #642c47 #484937 #98595a #c3736e #e3bbb0` — five of eight in the
red/pink/skin family, one bluish, one olive. Median cut allocates by POPULATION, and red + rose +
dark/grey is 15,923 of 26,839 texels (**59%**). The skin and top simply outvote the hair and skirt.

## What changes with size

| maxColors | flicker % | atlas KB | first appearance                                        |
| --------- | --------- | -------- | ------------------------------------------------------- |
| 8         | 0.190     | 26       | one bluish entry, one olive                             |
| 12        | 0.239     | 28       | the top separates into a clean pink; skirt gains a navy |
| **16**    | **0.244** | **28**   | `#417054` (green) and `#052522` (dark teal) — the HAIR  |
| 24        | 0.254     | 31       | two more greens; little visible change                  |

Flicker budget is 0.55%, so every size is comfortably inside it, and the cost between 8 and 16 is 2
KB. See `out/p3-exit/contact/palette-sizes.png` and `ref-vs-8-16.png`.

## Two things this does NOT fix

**The reference's colours are not in the texture.** Albedo has the hair at `#186a4c` — a GREEN — and
the skirt at `#17113a`, a very dark navy. The reference is teal `#5fd6d0` hair and a mid blue skirt.
No palette can produce a colour its input does not contain; this is the TRELLIS.2 texture-fidelity
gap already documented in GUIDANCE-REPORT.md, and it is upstream of everything here.

**The lighting halves the value.** albedo 0.584 → raw lit 0.352, a 40% darkening that is independent
of palette size and applies to every entry. It is why even the 24-colour sheet reads darker than the
reference. Whether that is the light rig or the shader's sRGB handling is not established here — it
is a separate measurement, and it was NOT the cause of the hue loss, so it was not chased.
