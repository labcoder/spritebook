/**
 * Read the render module's AOV PNGs (files in, across the D-004 seam) into
 * decoded AovImage planes. lit/albedo/normal decode to 8-bit RGBA; depth/mask
 * decode to 16-bit single-channel. fast-png is lossless, so the planes are the
 * exact bytes the renderer read back.
 */
import { decode as decodePng } from 'fast-png';
import { aovFileName, type AovImage } from './contracts.ts';

async function readPng(framesDir: string, direction: number, frame: number, pass: string) {
  const path = `${framesDir}/${aovFileName(direction, frame, pass)}`;
  return decodePng(await Deno.readFile(path));
}

export async function readAov(
  framesDir: string,
  direction: number,
  frame: number,
): Promise<AovImage> {
  const lit = await readPng(framesDir, direction, frame, 'lit');
  const albedo = await readPng(framesDir, direction, frame, 'albedo');
  const normal = await readPng(framesDir, direction, frame, 'normal');
  const depth = await readPng(framesDir, direction, frame, 'depth');
  const mask = await readPng(framesDir, direction, frame, 'mask');
  return {
    width: lit.width,
    height: lit.height,
    lit: lit.data as Uint8Array,
    albedo: albedo.data as Uint8Array,
    normal: normal.data as Uint8Array,
    depth: depth.data as Uint16Array,
    mask: mask.data as Uint16Array,
  };
}

/** Straight-alpha coverage plane (one byte per pixel) from the lit RGBA alpha. */
export function coverageFromLit(lit: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = lit[i * 4 + 3];
  return out;
}
