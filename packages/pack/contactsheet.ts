/**
 * Contact-sheet GIF — a REVIEW ARTIFACT ONLY (BOM: "player is interactive,
 * never GIF"; the eventual web tool animates sprite frames directly). One GIF
 * per clip: all directions side by side, animating over the clip's frames.
 * Styled cells are composited onto a fixed light background (GIF transparency
 * is quirky and review sheets read better on a background), quantized ONCE with
 * a single global palette across all frames so the sheet itself cannot flicker.
 * Deterministic: gifenc's quantize/applyPalette have no RNG; same cells -> same
 * bytes.
 */
import gifenc from 'gifenc';
import { type FrameId, frameIdKey } from './contracts.ts';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const BG: [number, number, number] = [240, 240, 240];

/** Review GIFs stay bounded; exported atlas cells retain their full resolution. */
export function contactThumbnail(
  rgba: Uint8Array,
  w: number,
  h: number,
): { rgba: Uint8Array; w: number; h: number } {
  const scale = Math.min(1, 256 / Math.max(w, h));
  if (scale === 1) return { rgba, w, h };
  const width = Math.max(1, Math.round(w * scale)), height = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from =
        (Math.min(h - 1, Math.floor(y / scale)) * w + Math.min(w - 1, Math.floor(x / scale))) * 4;
      out.set(rgba.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { rgba: out, w: width, h: height };
}

/** Straight-alpha over the fixed background into a flat sheet row. */
function blit(
  sheet: Uint8Array,
  sheetW: number,
  cell: Uint8Array,
  cellW: number,
  cellH: number,
  xOff: number,
): void {
  for (let y = 0; y < cellH; y++) {
    for (let x = 0; x < cellW; x++) {
      const s = (y * cellW + x) * 4;
      const d = (y * sheetW + xOff + x) * 4;
      const a = cell[s + 3] / 255;
      sheet[d] = Math.round(cell[s] * a + BG[0] * (1 - a));
      sheet[d + 1] = Math.round(cell[s + 1] * a + BG[1] * (1 - a));
      sheet[d + 2] = Math.round(cell[s + 2] * a + BG[2] * (1 - a));
      sheet[d + 3] = 255;
    }
  }
}

/**
 * Build the animated contact-sheet GIF for one clip. `cells` maps frameIdKey ->
 * decoded 1x rgba8 cell (cellW*cellH*4).
 */
export function buildContactSheet(
  cells: Map<string, Uint8Array>,
  opts: {
    clipId: string;
    directions: number;
    frames: number;
    cellW: number;
    cellH: number;
    fps: number;
  },
): Uint8Array {
  const { clipId, directions, frames, cellW, cellH, fps } = opts;
  const sheetW = directions * cellW;
  const sheetH = cellH;

  // composite every animation frame's sheet first, so ONE palette spans them all
  const sheets: Uint8Array[] = [];
  for (let f = 0; f < frames; f++) {
    const sheet = new Uint8Array(sheetW * sheetH * 4);
    for (let d = 0; d < directions; d++) {
      const id: FrameId = { clipId, direction: d, frame: f };
      const cell = cells.get(frameIdKey(id));
      if (!cell) throw new Error(`contact sheet: missing cell ${frameIdKey(id)}`);
      if (cell.length !== cellW * cellH * 4) {
        throw new Error(`contact sheet: cell ${frameIdKey(id)} is not ${cellW}x${cellH} rgba8`);
      }
      blit(sheet, sheetW, cell, cellW, cellH, d * cellW);
    }
    sheets.push(sheet);
  }

  const pooled = new Uint8Array(sheets.length * sheetW * sheetH * 4);
  sheets.forEach((s, i) => pooled.set(s, i * sheetW * sheetH * 4));
  const palette = quantize(pooled, 256);

  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);
  for (const sheet of sheets) {
    gif.writeFrame(applyPalette(sheet, palette), sheetW, sheetH, { palette, delay });
  }
  gif.finish();
  return gif.bytes();
}
