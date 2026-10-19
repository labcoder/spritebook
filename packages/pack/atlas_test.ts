import { test } from 'node:test';
import { assert, assertEquals, assertThrows } from '@std/assert';
import { decode as decodePng } from 'fast-png';
import { type CellPlane, frameIdKey, type PackLayout } from './dist/contracts.js';
import { assertRectIdentity, composePage, encodePagePng } from './dist/atlas.js';
import { packLayout } from './dist/maxrects.js';

// Hand-built layout: two 2x2 cells on an 8px page, plus one on a second page.
function twoCellLayout(): PackLayout {
  return {
    pageCount: 2,
    pageSizePx: 8,
    rects: [
      { id: { clipId: 'idle', direction: 0, frame: 0 }, pageIndex: 0, x: 1, y: 1, w: 2, h: 2 },
      { id: { clipId: 'idle', direction: 0, frame: 1 }, pageIndex: 0, x: 5, y: 3, w: 2, h: 2 },
      { id: { clipId: 'idle', direction: 1, frame: 0 }, pageIndex: 1, x: 0, y: 0, w: 2, h: 2 },
    ],
  };
}

/** 2x2 rgba cell whose byte at pixel p, channel c is base + p*4 + c. */
function rgbaCell(base: number): CellPlane {
  return { w: 2, h: 2, rgba: Uint8Array.from({ length: 16 }, (_, i) => base + i) };
}

function gray16Cell(values: number[]): CellPlane {
  return { w: 2, h: 2, gray16: Uint16Array.from(values) };
}

function rgbaCells(): Map<string, CellPlane> {
  return new Map([
    ['idle/d00/f000', rgbaCell(10)],
    ['idle/d00/f001', rgbaCell(200)],
    ['idle/d01/f000', rgbaCell(100)],
  ]);
}

function px(page: CellPlane, x: number, y: number): number[] {
  const o = (y * page.w + x) * 4;
  return [...page.rgba!.subarray(o, o + 4)];
}

// --- composePage -------------------------------------------------------------

test('composePage: rgba8 cells land at their rects, exact corner pixels', () => {
  const page = composePage(twoCellLayout(), 0, rgbaCells(), 'rgba8');
  assertEquals(page.w, 8);
  assertEquals(page.h, 8);
  assertEquals(page.rgba!.length, 8 * 8 * 4);
  // cell A at (1,1): its four pixels row by row
  assertEquals(px(page, 1, 1), [10, 11, 12, 13]);
  assertEquals(px(page, 2, 1), [14, 15, 16, 17]);
  assertEquals(px(page, 1, 2), [18, 19, 20, 21]);
  assertEquals(px(page, 2, 2), [22, 23, 24, 25]);
  // cell B at (5,3)
  assertEquals(px(page, 5, 3), [200, 201, 202, 203]);
  assertEquals(px(page, 6, 4), [212, 213, 214, 215]);
  // everywhere else stays transparent
  assertEquals(px(page, 0, 0), [0, 0, 0, 0]);
  assertEquals(px(page, 3, 1), [0, 0, 0, 0]);
  assertEquals(px(page, 7, 7), [0, 0, 0, 0]);
});

test('composePage: only rects of the requested page are composed', () => {
  const page1 = composePage(twoCellLayout(), 1, rgbaCells(), 'rgba8');
  assertEquals(px(page1, 0, 0), [100, 101, 102, 103]); // idle/d01/f000
  assertEquals(px(page1, 5, 3), [0, 0, 0, 0]); // page-0 rect is absent here
});

test('composePage: gray16 cells land with 16-bit values intact', () => {
  const cells = new Map([
    ['idle/d00/f000', gray16Cell([0x1234, 0x2345, 0x3456, 0x4567])],
    ['idle/d00/f001', gray16Cell([0xfedc, 0xedcb, 0xdcba, 0xcba9])],
    ['idle/d01/f000', gray16Cell([1, 2, 3, 4])],
  ]);
  const page = composePage(twoCellLayout(), 0, cells, 'gray16');
  assertEquals(page.gray16!.length, 64);
  assertEquals(page.gray16![1 * 8 + 1], 0x1234);
  assertEquals(page.gray16![2 * 8 + 2], 0x4567);
  assertEquals(page.gray16![3 * 8 + 5], 0xfedc);
  assertEquals(page.gray16![4 * 8 + 6], 0xcba9);
  assertEquals(page.gray16![0], 0);
});

test('composePage: a missing cell throws with its key', () => {
  const cells = rgbaCells();
  cells.delete('idle/d00/f001');
  assertThrows(
    () => composePage(twoCellLayout(), 0, cells, 'rgba8'),
    Error,
    'missing cell plane for idle/d00/f001',
  );
});

test('composePage: a cell whose size mismatches its rect throws', () => {
  const cells = rgbaCells();
  cells.set('idle/d00/f001', { w: 3, h: 2, rgba: new Uint8Array(24) });
  assertThrows(() => composePage(twoCellLayout(), 0, cells, 'rgba8'), Error, '3x2');
});

test('composePage: a cell missing the plane the page kind needs throws', () => {
  const cells = rgbaCells();
  cells.set('idle/d00/f001', gray16Cell([1, 2, 3, 4]));
  assertThrows(() => composePage(twoCellLayout(), 0, cells, 'rgba8'), Error, 'rgba');
  assertThrows(() => composePage(twoCellLayout(), 0, rgbaCells(), 'gray16'), Error, 'gray16');
});

test('composePage: pageIndex out of range and overflowing rects throw', () => {
  assertThrows(
    () => composePage(twoCellLayout(), 2, rgbaCells(), 'rgba8'),
    RangeError,
    'pageIndex',
  );
  const broken = twoCellLayout();
  broken.rects[1].x = 7; // 7 + 2 > 8
  assertThrows(() => composePage(broken, 0, rgbaCells(), 'rgba8'), Error, 'overflows');
});

// --- assertRectIdentity ------------------------------------------------------

test('assertRectIdentity: one layout replayed five times passes (the law)', () => {
  const layout = twoCellLayout();
  assertRectIdentity([layout, layout, layout, layout, layout]);
  // a value-identical copy passes too — identity is by value, not reference
  assertRectIdentity([layout, structuredClone(layout)]);
  assertRectIdentity([]);
  assertRectIdentity([layout]);
});

test('assertRectIdentity: a mutated copy throws naming the divergence', () => {
  const layout = twoCellLayout();
  const shifted = structuredClone(layout);
  shifted.rects[1].x += 1;
  assertThrows(
    () => assertRectIdentity([layout, layout, shifted]),
    Error,
    'layout 2 diverges at rect 1 (idle/d00/f001): x 6 !== 5',
  );
  const renamed = structuredClone(layout);
  renamed.rects[0].id.frame = 9;
  assertThrows(() => assertRectIdentity([layout, renamed]), Error, 'frame 9 !== 0');
  const resized = structuredClone(layout);
  resized.pageSizePx = 16;
  assertThrows(() => assertRectIdentity([layout, resized]), Error, 'pageSizePx 16 !== 8');
  const shrunk = structuredClone(layout);
  shrunk.rects.pop();
  assertThrows(() => assertRectIdentity([layout, shrunk]), Error, 'has 2 rects');
  const paged = structuredClone(layout);
  paged.pageCount = 3;
  assertThrows(() => assertRectIdentity([layout, paged]), Error, 'pageCount 3 !== 2');
});

// --- encodePagePng -----------------------------------------------------------

test('encodePagePng: gray16 round-trips through fast-png losslessly', () => {
  const cells = new Map([
    ['idle/d00/f000', gray16Cell([0x1234, 0x2345, 0x3456, 0x4567])],
    ['idle/d00/f001', gray16Cell([0xfedc, 0xedcb, 0xdcba, 0xcba9])],
    ['idle/d01/f000', gray16Cell([1, 2, 3, 4])],
  ]);
  const page = composePage(twoCellLayout(), 0, cells, 'gray16');
  const png = encodePagePng(page, 'gray16');
  const decoded = decodePng(png);
  assertEquals(decoded.width, 8);
  assertEquals(decoded.height, 8);
  assertEquals(decoded.depth, 16);
  assertEquals(decoded.channels, 1);
  assert(decoded.data instanceof Uint16Array);
  assertEquals(decoded.data, page.gray16!);
});

test('encodePagePng: rgba8 round-trips through fast-png losslessly', () => {
  const page = composePage(twoCellLayout(), 0, rgbaCells(), 'rgba8');
  const decoded = decodePng(encodePagePng(page, 'rgba8'));
  assertEquals(decoded.width, 8);
  assertEquals(decoded.depth, 8);
  assertEquals(decoded.channels, 4);
  assertEquals(decoded.data, page.rgba!);
});

test('encodePagePng: a plane missing the requested kind throws', () => {
  const rgbaPage: CellPlane = { w: 2, h: 2, rgba: new Uint8Array(16) };
  const grayPage: CellPlane = { w: 2, h: 2, gray16: new Uint16Array(4) };
  assertThrows(() => encodePagePng(rgbaPage, 'gray16'), RangeError);
  assertThrows(() => encodePagePng(grayPage, 'rgba8'), RangeError);
});

// --- integration with packLayout --------------------------------------------

test('composePage: a packLayout layout composes with every cell at its rect', () => {
  const layout = packLayout([
    { id: { clipId: 'walk', direction: 0, frame: 0 }, w: 2, h: 2 },
    { id: { clipId: 'walk', direction: 0, frame: 1 }, w: 3, h: 1 },
  ], { gapPx: 1 });
  assertEquals(layout.pageCount, 1);
  const cells = new Map<string, CellPlane>([
    ['walk/d00/f000', rgbaCell(40)],
    ['walk/d00/f001', { w: 3, h: 1, rgba: Uint8Array.from({ length: 12 }, (_, i) => 80 + i) }],
  ]);
  const page = composePage(layout, 0, cells, 'rgba8');
  for (const rect of layout.rects) {
    const cell = cells.get(frameIdKey(rect.id))!;
    // first and last pixel of each rect match the cell's corners
    assertEquals(px(page, rect.x, rect.y), [...cell.rgba!.subarray(0, 4)]);
    assertEquals(
      px(page, rect.x + rect.w - 1, rect.y + rect.h - 1),
      [...cell.rgba!.subarray((rect.w * rect.h - 1) * 4)],
    );
  }
});
