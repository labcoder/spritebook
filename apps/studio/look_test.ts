import { test } from 'node:test';
/**
 * The Look stage's pure parts, pinned: resolution (preset under overrides)
 * matches what core's resolveCamera/resolveStyle would produce, the arg
 * builder emits only DIVERGENCE, and the staleness statement is all-or-none
 * because every frame key embeds the whole recipe.
 */
import { assertEquals } from '@std/assert';
import {
  comparisonDirections,
  DIRECTION_CHOICES,
  ELEVATION_DETENTS,
  lookArgs,
  type LookDraft,
  resolvedCamera,
  resolvedStyle,
  staleFrames,
} from './src/look.ts';

test('comparison uses available angles, including sparse and empty bakes', () => {
  assertEquals(comparisonDirections([]), []);
  assertEquals(comparisonDirections([0, 4]), [0, 4]);
  assertEquals(comparisonDirections([0, 1, 2, 3, 4, 5, 6, 7]), [0, 2, 4]);
  assertEquals(comparisonDirections([1, 3, 5, 7]), [1, 3, 5]);
});

const CAMERAS = [
  {
    id: 'standard-30',
    elevationDeg: 30,
    directions: 8,
    yawOffsetDeg: 0,
    pixelsPerMeter: 32,
    cellPx: { w: 64, h: 64 },
    paddingPx: 6,
  },
  {
    id: 'low-15',
    elevationDeg: 15,
    directions: 8,
    yawOffsetDeg: 0,
    pixelsPerMeter: 32,
    cellPx: { w: 64, h: 64 },
    paddingPx: 6,
  },
];
const STYLES = [
  { id: 'pixel', mode: 'pixel', maxColors: 16, outlineWidthPx: 0.5 },
  { id: 'clean', mode: 'painterly' },
];

test('the detents are the ones core’s schema documents', () => {
  assertEquals(ELEVATION_DETENTS.map((d) => d.deg), [15, 26.565, 30, 35.264]);
  assertEquals([...DIRECTION_CHOICES], [2, 4, 8, 16]);
});

test('resolution is preset defaults UNDER recorded overrides', () => {
  const plain = resolvedCamera(
    CAMERAS,
    { cameraPresetId: 'low-15', stylePresetId: 'pixel' },
    'standard-30',
  )!;
  assertEquals(plain.elevationDeg, 15, 'the preset speaks when nothing overrides it');

  const over = resolvedCamera(CAMERAS, {
    cameraPresetId: 'standard-30',
    cameraOverrides: { elevationDeg: 26.565, cellPx: { w: 96, h: 128 } },
    stylePresetId: 'pixel',
  }, 'standard-30')!;
  assertEquals(over.elevationDeg, 26.565);
  assertEquals(over.cellPx, { w: 96, h: 128 }, 'cellPx replaces wholesale, like core');
  assertEquals(over.directions, 8, 'un-overridden fields keep the preset value');

  const style = resolvedStyle(STYLES, {
    cameraPresetId: 'standard-30',
    stylePresetId: 'pixel',
    overrides: { quantize: { maxColors: 24 } },
  }, 'pixel')!;
  assertEquals(style.maxColors, 24);
  assertEquals(style.outlineWidthPx, 0.5, 'the preset outline survives a palette override');

  const noLook = resolvedStyle(STYLES, undefined, 'pixel')!;
  assertEquals(noLook.maxColors, 16, 'no look at all falls back to the default preset');
});

test('the twin carries ONLY divergence from the presets', () => {
  const base: LookDraft = {
    cameraPresetId: 'standard-30',
    stylePresetId: 'pixel',
    elevationDeg: 30,
    directions: 8,
    pixelsPerMeter: 32,
    cellW: 64,
    cellH: 64,
    maxColors: 16,
    outlineWidthPx: 0.5,
  };
  assertEquals(lookArgs('W', base, CAMERAS[0], STYLES[0]), [
    'look',
    '--workspace',
    'W',
    '--camera',
    'standard-30',
    '--style',
    'pixel',
  ], 'at the preset defaults, nothing else travels');

  const moved = lookArgs('W', { ...base, elevationDeg: 15, maxColors: 24 }, CAMERAS[0], STYLES[0]);
  assertEquals(moved.slice(-4), ['--elevation', '15', '--colors', '24']);

  // a square cell collapses to one number, a portrait one does not
  assertEquals(
    lookArgs('W', { ...base, cellW: 96, cellH: 96 }, CAMERAS[0], STYLES[0]).slice(-2),
    ['--cell', '96'],
  );
  assertEquals(
    lookArgs('W', { ...base, cellW: 96, cellH: 128 }, CAMERAS[0], STYLES[0]).slice(-2),
    ['--cell', '96x128'],
  );
});

test('staleness is all-or-none, and zero when nothing is baked', () => {
  const rec: LookDraft = {
    cameraPresetId: 'standard-30',
    stylePresetId: 'pixel',
    elevationDeg: 30,
    directions: 8,
    pixelsPerMeter: 32,
    cellW: 64,
    cellH: 64,
    maxColors: 16,
    outlineWidthPx: 0.5,
  };
  assertEquals(staleFrames(48, rec, rec), 0, 'an unchanged look invalidates nothing');
  assertEquals(staleFrames(48, { ...rec, maxColors: 17 }, rec), 48, 'one colour stales ALL 48');
  assertEquals(staleFrames(48, { ...rec, elevationDeg: 15 }, rec), 48);
  assertEquals(staleFrames(0, { ...rec, elevationDeg: 15 }, rec), 0, 'nothing baked, nothing lost');
  assertEquals(staleFrames(48, rec, null), 0, 'no recorded look to diverge from');
});
