/**
 * Alpha finishing (npr-sprite-stylization skill): pixel styles cut to 1-bit
 * alpha at a preset threshold at the END; then edge colors are DILATED into
 * transparent texels (bleed) before atlas write, because engines bilinear-filter
 * across sprite edges and will pull whatever color sits in transparent pixels —
 * producing dark halos if those are black. Work in straight (unpremultiplied)
 * alpha throughout.
 */

/** In-place 1-bit alpha cut: alpha >= cutoff*255 -> 255, else 0. */
export function cutAlpha1bit(rgba: Uint8Array, cutoff01: number): void {
  const t = cutoff01 * 255;
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = rgba[i] >= t ? 255 : 0;
}

/**
 * In-place edge-color dilation (bleed): grow the opaque region's COLOR outward
 * by `bleedPx` rings into transparent texels (alpha stays 0). A `colored` mask
 * (opaque OR already-bled) grows one ring per pass — each pass reads a snapshot
 * of the previous ring so growth is exactly one pixel per pass out to bleedPx.
 * Fixed 4-neighbour precedence (N,E,S,W) makes the result byte-stable.
 */
export function dilateEdgeColors(
  rgba: Uint8Array,
  width: number,
  height: number,
  bleedPx: number,
): void {
  const idx = (x: number, y: number) => (y * width + x) * 4;
  const colored = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) colored[p] = rgba[p * 4 + 3] > 0 ? 1 : 0;

  for (let pass = 0; pass < bleedPx; pass++) {
    const source = colored.slice(); // ring sources fixed at pass start
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (colored[p]) continue;
        const neigh: Array<[number, number]> = [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]];
        for (const [nx, ny] of neigh) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (!source[ny * width + nx]) continue;
          const s = idx(nx, ny), d = idx(x, y);
          rgba[d] = rgba[s];
          rgba[d + 1] = rgba[s + 1];
          rgba[d + 2] = rgba[s + 2]; // alpha stays 0
          colored[p] = 1;
          break;
        }
      }
    }
  }
}
