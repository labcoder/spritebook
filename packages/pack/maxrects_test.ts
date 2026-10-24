import { test } from 'node:test';
import { assert, assertEquals, assertThrows } from '@std/assert';
import { frameIdKey, type PackLayout } from './dist/contracts.js';
import {
  packAnimationLayout,
  type PackCell,
  packLayout,
  PINNED_PACKER_OPTIONS,
} from './dist/maxrects.js';

function cell(clipId: string, direction: number, frame: number, w: number, h: number): PackCell {
  return { id: { clipId, direction, frame }, w, h };
}

/** 16 uniform 96x96 cells (idle, 4 directions x 4 frames) — the T3 shape. */
function uniform16(): PackCell[] {
  const cells: PackCell[] = [];
  for (let d = 0; d < 4; d++) {
    for (let f = 0; f < 4; f++) cells.push(cell('idle', d, f, 96, 96));
  }
  return cells;
}

test('multi-page animation packing keeps complete sequences together without overlap or dropped frames', () => {
  const cells = Array.from(
    { length: 8 },
    (_, direction) =>
      Array.from({ length: 16 }, (_, frame) => cell('walk', direction, frame, 256, 320)),
  ).flat();
  const layout = packAnimationLayout(cells);
  assert(layout.pageCount > 1);
  assertEquals(layout.rects.length, cells.length);
  assertEquals(new Set(layout.rects.map((rect) => frameIdKey(rect.id))).size, cells.length);
  for (let direction = 0; direction < 8; direction++) {
    assertEquals(
      new Set(
        layout.rects.filter((rect) => rect.id.direction === direction).map((rect) =>
          rect.pageIndex
        ),
      ).size,
      1,
    );
  }
  assertSeparated(layout, 2);
  assertEquals(layout, packAnimationLayout([...cells].reverse()));
});

test('animation larger than a page retains every frame for multi-page-capable exporters', () => {
  const cells = Array.from({ length: 8 }, (_, frame) => cell('large', 0, frame, 512, 512));
  const layout = packAnimationLayout(cells, { maxPageSizePx: 512 });
  assertEquals(layout.pageCount, 8);
  assertEquals(layout.rects.length, 8);
});

test('512px walk and jump cycles stay complete within the bounded 4096px bake budget', () => {
  const cells = ['walk-loop', 'jump-start', 'jump-loop', 'jump-land'].flatMap((clipId) =>
    Array.from(
      { length: 8 },
      (_, direction) =>
        Array.from(
          { length: clipId === 'walk-loop' ? 12 : 6 },
          (_, frame) => cell(clipId, direction, frame, 512, 512),
        ),
    ).flat()
  );
  const layout = packAnimationLayout(cells, { maxPageSizePx: 4096 });
  assertEquals(layout.rects.length, 240);
  assertEquals(new Set(layout.rects.map((rect) => frameIdKey(rect.id))).size, 240);
  assert(layout.pageSizePx <= 4096);
  for (const clipId of ['walk-loop', 'jump-start', 'jump-loop', 'jump-land']) {
    for (let direction = 0; direction < 8; direction++) {
      const frames = layout.rects.filter((rect) =>
        rect.id.clipId === clipId && rect.id.direction === direction
      );
      assertEquals(new Set(frames.map((rect) => rect.pageIndex)).size, 1);
    }
  }
  assertSeparated(layout, 2);
  assertEquals(layout, packAnimationLayout([...cells].reverse(), { maxPageSizePx: 4096 }));

  const single4k = packAnimationLayout([cell('still', 0, 0, 4096, 4096)], {
    maxPageSizePx: 4096,
  });
  assertEquals(single4k.pageSizePx, 4096);
  assertEquals(single4k.pageCount, 1);
  assertEquals(single4k.rects[0], {
    id: { clipId: 'still', direction: 0, frame: 0 },
    pageIndex: 0,
    x: 0,
    y: 0,
    w: 4096,
    h: 4096,
  });
});

test('an oversized sequence does not split neighboring animations that fit their page', () => {
  const cells = ['jump', 'walk'].flatMap((clipId) =>
    Array.from(
      { length: 3 },
      (_, direction) =>
        Array.from(
          { length: clipId === 'walk' ? 12 : 6 },
          (_, frame) => cell(clipId, direction, frame, 512, 512),
        ),
    ).flat()
  );
  const layout = packAnimationLayout(cells, { maxPageSizePx: 2048 });
  assertEquals(layout.rects.length, cells.length);
  for (let direction = 0; direction < 3; direction++) {
    const pages = (clipId: string) =>
      new Set(
        layout.rects.filter((rect) => rect.id.clipId === clipId && rect.id.direction === direction)
          .map((rect) => rect.pageIndex),
      ).size;
    assertEquals(pages('jump'), 1, 'the six-frame jump fits and remains complete');
    assert(pages('walk') > 1, 'the twelve-frame walk honestly exceeds the page budget');
  }
  assertSeparated(layout, 2);
  assertEquals(layout, packAnimationLayout([...cells].reverse(), { maxPageSizePx: 2048 }));
});

/** Mixed sizes — packLayout must not assume uniform cells. */
function mixed(): PackCell[] {
  return [
    cell('a', 0, 0, 96, 96),
    cell('a', 0, 1, 64, 32),
    cell('a', 1, 0, 32, 64),
    cell('b', 0, 0, 128, 128),
    cell('b', 0, 1, 200, 40),
    cell('b', 1, 0, 40, 200),
    cell('c', 0, 0, 96, 96),
  ];
}

/** Any two same-page rects must be >= gapPx apart on at least one axis (so: no overlap). */
function assertSeparated(layout: PackLayout, gapPx: number): void {
  for (let i = 0; i < layout.rects.length; i++) {
    for (let j = i + 1; j < layout.rects.length; j++) {
      const a = layout.rects[i];
      const b = layout.rects[j];
      if (a.pageIndex !== b.pageIndex) continue;
      const separated = a.x + a.w + gapPx <= b.x || b.x + b.w + gapPx <= a.x ||
        a.y + a.h + gapPx <= b.y || b.y + b.h + gapPx <= a.y;
      assert(
        separated,
        `rects ${frameIdKey(a.id)} and ${
          frameIdKey(b.id)
        } are closer than ${gapPx}px on page ${a.pageIndex}`,
      );
    }
  }
}

// --- determinism -------------------------------------------------------------

test('packLayout: packing twice yields deep-equal layouts (the determinism canary)', () => {
  assertEquals(packLayout(uniform16()), packLayout(uniform16()));
  assertEquals(packLayout(mixed()), packLayout(mixed()));
  // overflow config exercises the multi-page path too
  const opts = { maxPageSizePx: 256, gapPx: 2 };
  assertEquals(packLayout(uniform16(), opts), packLayout(uniform16(), opts));
  assertEquals(packLayout(mixed(), opts), packLayout(mixed(), opts));
});

test('packLayout: input order does not matter (canonical sort first)', () => {
  const sorted = mixed();
  const scrambled = [3, 0, 6, 2, 5, 1, 4].map((i) => sorted[i]);
  assertEquals(packLayout(scrambled), packLayout(sorted));
});

test('packLayout: the pinned packer options stay pinned', () => {
  // A change here changes every layout ever baked — treat as a format bump, not a tweak.
  assertEquals(PINNED_PACKER_OPTIONS, {
    smart: false,
    pot: false,
    square: false,
    allowRotation: false,
    tag: false,
    border: 0,
  });
});

test('packLayout: pinned placement golden (fires if a packer update moves rects)', () => {
  const layout = packLayout([cell('g', 0, 0, 96, 96), cell('g', 0, 1, 96, 96)]);
  assertEquals(layout, {
    pageCount: 1,
    pageSizePx: 256, // two 98px consumed cells do not fit a 128px page -> 256
    rects: [
      { id: { clipId: 'g', direction: 0, frame: 0 }, pageIndex: 0, x: 0, y: 0, w: 96, h: 96 },
      { id: { clipId: 'g', direction: 0, frame: 1 }, pageIndex: 0, x: 0, y: 98, w: 96, h: 96 },
    ],
  });
});

// --- geometry laws -----------------------------------------------------------

test('packLayout: rects stay inside the page bounds', () => {
  for (const layout of [packLayout(mixed()), packLayout(uniform16(), { maxPageSizePx: 256 })]) {
    for (const rect of layout.rects) {
      assert(rect.x >= 0 && rect.y >= 0, `${frameIdKey(rect.id)} at negative position`);
      assert(
        rect.x + rect.w <= layout.pageSizePx && rect.y + rect.h <= layout.pageSizePx,
        `${frameIdKey(rect.id)} overflows the ${layout.pageSizePx}px page`,
      );
      assert(rect.pageIndex >= 0 && rect.pageIndex < layout.pageCount, 'pageIndex out of range');
    }
  }
});

test('packLayout: no overlaps and the gap is respected (uniform + mixed, overflow too)', () => {
  assertSeparated(packLayout(uniform16()), 2);
  assertSeparated(packLayout(mixed()), 2);
  assertSeparated(packLayout(uniform16(), { maxPageSizePx: 256, gapPx: 2 }), 2);
  assertSeparated(packLayout(mixed(), { maxPageSizePx: 256, gapPx: 7 }), 7);
});

test('packLayout: gapPx 0 packs flush without overlap', () => {
  const layout = packLayout([cell('g', 0, 0, 96, 96), cell('g', 0, 1, 96, 96)], { gapPx: 0 });
  assertEquals(layout.pageCount, 1);
  assertSeparated(layout, 0);
});

// --- page sizing -------------------------------------------------------------

test('packLayout: page size is the smallest fitting power of two', () => {
  // 16x 96px + 2px gap: a 256 page holds 4, so 512 is the smallest single page
  const layout = packLayout(uniform16());
  assertEquals(layout.pageCount, 1);
  assertEquals(layout.pageSizePx, 512);
  // one small cell -> the smallest pot square that holds its edge
  assertEquals(packLayout([cell('a', 0, 0, 96, 96)]).pageSizePx, 128);
  assertEquals(packLayout([cell('a', 0, 0, 100, 40)]).pageSizePx, 128);
  for (const l of [layout, packLayout(mixed())]) {
    assert((l.pageSizePx & (l.pageSizePx - 1)) === 0, `${l.pageSizePx} is not a power of two`);
  }
});

test('packLayout: an exact-fit cell shares its page size (gap pads between rects only)', () => {
  const layout = packLayout([cell('a', 0, 0, 256, 256)], { maxPageSizePx: 256 });
  assertEquals(layout, {
    pageCount: 1,
    pageSizePx: 256,
    rects: [{
      id: { clipId: 'a', direction: 0, frame: 0 },
      pageIndex: 0,
      x: 0,
      y: 0,
      w: 256,
      h: 256,
    }],
  });
});

test('packLayout: overflow spills to more pages, all at the capped size', () => {
  const layout = packLayout(uniform16(), { maxPageSizePx: 256 });
  assertEquals(layout.pageSizePx, 256);
  assertEquals(layout.pageCount, 4); // 4 cells per 256 page
  const pages = new Set(layout.rects.map((r) => r.pageIndex));
  assertEquals([...pages].sort((a, b) => a - b), [0, 1, 2, 3]);
});

test('packLayout: a non-pot maxPageSizePx caps at the largest pot below it', () => {
  const layout = packLayout(uniform16(), { maxPageSizePx: 300 });
  assertEquals(layout.pageSizePx, 256);
  assertEquals(layout.pageCount, 4);
});

// --- canonical order ---------------------------------------------------------

test('packLayout: rects come back sorted by frameIdKey', () => {
  const scrambled = [6, 2, 4, 0, 5, 3, 1].map((i) => mixed()[i]);
  const keys = packLayout(scrambled).rects.map((r) => frameIdKey(r.id));
  assertEquals(keys, [...keys].sort());
  assertEquals(keys, mixed().map((c) => frameIdKey(c.id)).sort());
});

// --- errors and edges --------------------------------------------------------

test('packLayout: a single cell exceeding maxPageSizePx throws', () => {
  assertThrows(
    () => packLayout([cell('big', 0, 0, 300, 10)], { maxPageSizePx: 256 }),
    RangeError,
    'exceeds the largest page',
  );
  assertThrows(() => packLayout([cell('big', 0, 0, 10, 4096)]), RangeError, 'exceeds');
});

test('packLayout: duplicate frame ids throw', () => {
  assertThrows(
    () => packLayout([cell('a', 0, 0, 8, 8), cell('a', 0, 0, 8, 8)]),
    Error,
    'duplicate frame id a/d00/f000',
  );
});

test('packLayout: invalid cell sizes and options throw', () => {
  assertThrows(() => packLayout([cell('a', 0, 0, 0, 8)]), RangeError, 'invalid size');
  assertThrows(() => packLayout([cell('a', 0, 0, 8.5, 8)]), RangeError, 'invalid size');
  assertThrows(() => packLayout([cell('a', 0, 0, 8, 8)], { gapPx: -1 }), RangeError, 'gapPx');
  assertThrows(() => packLayout([cell('a', 0, 0, 8, 8)], { gapPx: 1.5 }), RangeError, 'gapPx');
  assertThrows(() => packLayout([cell('a', 0, 0, 8, 8)], { maxPageSizePx: 0 }), RangeError);
});

test('packLayout: empty input packs to zero pages', () => {
  assertEquals(packLayout([]), { pageCount: 0, pageSizePx: 0, rects: [] });
});

test('packLayout: the mixed-layout golden pins exact coordinates (D-022 tripwire)', () => {
  // Captured from maxrects-packer@2.7.3 under PINNED_PACKER_OPTIONS. Atlas rects
  // feed cache-stable bakes whose keys do NOT include the packer version, so a
  // silent algorithm change would break "same inputs -> identical bytes" without
  // any other test firing. If this golden fails after a deliberate packer
  // update, treat it as a bake-format bump (D-022), re-capture, and say why.
  const l = packLayout(mixed());
  assertEquals({ pageCount: l.pageCount, pageSizePx: l.pageSizePx }, {
    pageCount: 1,
    pageSizePx: 512,
  });
  const got = l.rects.map((
    r,
  ) => [r.id.clipId, r.id.direction, r.id.frame, r.pageIndex, r.x, r.y, r.w, r.h]);
  assertEquals(got, [
    ['a', 0, 0, 0, 0, 0, 96, 96],
    ['a', 0, 1, 0, 98, 0, 64, 32],
    ['a', 1, 0, 0, 164, 0, 32, 64],
    ['b', 0, 0, 0, 198, 0, 128, 128],
    ['b', 0, 1, 0, 0, 130, 200, 40],
    ['b', 1, 0, 0, 0, 172, 40, 200],
    ['c', 0, 0, 0, 0, 374, 96, 96],
  ]);
});
