/**
 * Ordered (Bayer) dithering. The threshold matrix is locked to pixel POSITION,
 * so it is temporally stable by construction (npr-sprite-stylization skill) —
 * unlike error diffusion, whose propagation path differs every frame and reads
 * as boiling noise (banned for animation). The pipeline perturbs a pixel's value
 * by `(bayer(x,y) - 0.5) * strength` before nearest-palette match, so neighbours
 * stipple between palette entries instead of all snapping to one.
 */

/** Recursive Bayer threshold matrix, normalized to [0,1). size is 4 or 8. */
export function bayerMatrix(size: 4 | 8): Float32Array {
  const gen = (n: number): number[][] => {
    if (n === 1) return [[0]];
    const half = gen(n / 2);
    const h = n / 2;
    const m = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        const v = half[y][x];
        m[y][x] = 4 * v;
        m[y][x + h] = 4 * v + 2;
        m[y + h][x] = 4 * v + 3;
        m[y + h][x + h] = 4 * v + 1;
      }
    }
    return m;
  };
  const m = gen(size);
  const out = new Float32Array(size * size);
  const denom = size * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) out[y * size + x] = m[y][x] / denom;
  }
  return out;
}

/** Bayer value in [0,1) for pixel (x,y), tiled by the matrix size. */
export function bayerValue(matrix: Float32Array, size: number, x: number, y: number): number {
  return matrix[(y % size) * size + (x % size)];
}
