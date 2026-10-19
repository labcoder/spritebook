declare module 'gifenc' {
  /**
   * Minimal typings for npm:gifenc (untyped upstream) — just what pack uses.
   * Named exports are shared by its CJS main and ESM bundle entry.
   */
  interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts: { palette: number[][]; delay: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }

  export function GIFEncoder(): GifEncoderInstance;
  export function quantize(rgba: Uint8Array, maxColors: number): number[][];
  export function applyPalette(rgba: Uint8Array, palette: number[][]): Uint8Array;
  const gifenc: {
    GIFEncoder: typeof GIFEncoder;
    quantize: typeof quantize;
    applyPalette: typeof applyPalette;
  };
  export default gifenc;
}
