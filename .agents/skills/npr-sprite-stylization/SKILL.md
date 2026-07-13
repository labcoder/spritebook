---
name: npr-sprite-stylization
description: The NPR stylization stack that turns raw 3D renders into pixel, cel, or painterly sprites — palette quantization, dithering, outline extraction, downsampling, and temporal stability across animation frames. Use this skill whenever implementing or tuning anything in the style pipeline: StylePreset execution, palette code, outline shaders, supersampling/downsample logic, or whenever sprites flicker, shimmer, or crawl between animation frames. The ordering and temporal rules here are the product's differentiator; deviating from them reintroduces the flicker problem this tool exists to solve.
---

# NPR sprite stylization

Style consistency across hundreds of characters comes from this shared stack, not from the models.
The historical warning: Dead Cells' team never solved inter-frame pixel flicker in their 3D→2D
pipeline. The rules below are the answer — treat the _order_ of operations as law, because most
flicker bugs are ordering bugs.

## The pipeline order (law)

1. **Render supersampled** at S× (2–4×) the output cell size, in linear color, via MRT: lit, albedo,
   normal, linear depth, object-ID.
2. **Extract outlines at supersample resolution** from depth + normal discontinuities (below).
3. **Composite** outline into the lit image; apply sRGB encode here — everything after operates in
   display space.
4. **Downsample S× → 1×.** For quantized (pixel) styles: cluster-vote. For painterly/cel: area
   average.
5. **Quantize** to the palette, with hysteresis.

Quantizing before downsampling, or downsampling by averaging in a quantized style, are the two
classic mistakes — both manufacture shimmer.

## Quantization

- Match colors in a **perceptual space (OKLab)**, not RGB Euclidean distance — RGB matching produces
  muddy skin tones and bad ramp choices at low palette counts.
- Fixed-palette mode: nearest palette entry, done. Adaptive mode: derive the palette (median cut or
  k-means) **once per character across all frames of all clips**, store it in the bake, reuse it
  forever. A palette computed per-frame guarantees flicker; this is non-negotiable.
- Quantization must be deterministic: fixed iteration order, fixed seeds. Same inputs → identical
  palette assignment, byte for byte.

## Dithering

- Default to **ordered (Bayer) dithering** (4×4 or 8×8). Its threshold matrix is locked to pixel
  position, so it is temporally stable by construction.
- **Error diffusion (Floyd–Steinberg) is banned for animation** — the error propagation path differs
  every frame, which reads as boiling noise. Permit it only for single stills behind an explicit
  preset flag.
- Dither strength is a preset parameter; apply it in the same color space you quantize in.

## Outlines

- Exterior silhouette: edge of the object-ID/alpha mask. Interior creases:
  `dot(n_a, n_b) < normalThreshold` OR `|depth_a − depth_b| > depthThreshold`, with the **depth
  threshold scaled by linear depth** — a constant threshold draws phantom lines up close and misses
  them far away.
- A 1 px outline at output resolution is S px at render resolution — derive stroke width from the
  supersample factor.
- Outline width must never exceed `CameraPreset.paddingPx`, or strokes clip at cell edges; assert
  this when validating presets.
- Outline color: derive from the palette (darkened ramp entry) rather than fixed black, so it
  survives palette swaps.

## The temporal-stability toolkit

These four techniques are what "temporal" in StylePreset means:

1. **Cluster-vote downsampling:** quantize the S× subpixels' _labels_, then take the majority label
   per output pixel. Never average colors then quantize — averaging invents in-between colors whose
   nearest palette entry flips frame to frame.
2. **Palette hysteresis:** keep the previous frame's palette index for a pixel unless the new
   candidate improves perceptual distance by more than ε. Kills single-pixel oscillation on
   gradients.
3. **Texel-grid snapping:** quantize camera position and character root motion to the
   pixels-per-meter grid before rendering. Sub-texel drift is where crawl _starts_; this prevents it
   at the source.
4. **Constant lighting per clip:** light direction and ramp are frozen across a clip's frames.
   Anything animated in the light shows up as full-body shimmer after quantization.

Measure it: the flicker metric is mean % of changed pixels frame-to-frame on a low-motion idle loop,
reported per bake and regression-tracked per preset (P2-T2 acceptance). When flicker regresses,
bisect against the four techniques above first.

## Alpha and edges

- Work in straight (unpremultiplied) alpha internally; pixel styles cut to 1-bit alpha at a preset
  threshold at the end.
- **Dilate edge colors into transparent texels** (alpha bleed) before atlas write — engines
  bilinear-filter across sprite edges and will pull in whatever color sits in transparent pixels,
  producing dark halos.
- Premultiply only if a specific exporter requires it, at write time.

## Style modes

- **Cel:** 2–4 stop toon ramp on N·L, optional rim term from N·V, quantization optional.
- **Pixel:** the full stack above, small palettes, 1-bit alpha.
- **Painterly:** optional edge-preserving (Kuwahara-family) filter before downsample, larger
  palettes or none. Any stochastic element takes a fixed seed from the manifest — determinism is a
  pipeline-wide invariant, not a pixel-style nicety.
