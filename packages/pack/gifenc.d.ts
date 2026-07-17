/**
 * Minimal typings for npm:gifenc (untyped upstream) — just what pack uses.
 * gifenc ships CJS via `main` with no `exports` map, so named ESM imports are
 * not statically visible; import the default namespace and destructure.
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

declare const gifenc: {
  GIFEncoder(): GifEncoderInstance;
  quantize(rgba: Uint8Array, maxColors: number): number[][];
  applyPalette(rgba: Uint8Array, palette: number[][]): Uint8Array;
};
export default gifenc;
