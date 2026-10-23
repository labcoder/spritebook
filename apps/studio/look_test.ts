import { test } from 'node:test';
/**
 * The Look stage's pure parts, pinned: resolution (preset under overrides)
 * matches what core's resolveCamera/resolveStyle would produce, the arg
 * builder carries capture settings through the real CLI contract.
 */
import { assertEquals } from '@std/assert';
import { lookArgs, type LookDraft, resolvedCamera, resolvedStyle } from './src/look.ts';

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

test('capture settings preserve projection, turn, resolution and lighting through the CLI', () => {
  const cam = resolvedCamera(CAMERAS, {
    cameraPresetId: 'standard-30',
    stylePresetId: 'clean',
    cameraOverrides: { yawOffsetDeg: 90, orthographic: false, fovDeg: 45 },
  }, 'standard-30')!;
  assertEquals([cam.yawOffsetDeg, cam.orthographic, cam.fovDeg], [90, false, 45]);
  const draft: LookDraft = {
    cameraPresetId: cam.id,
    stylePresetId: 'clean',
    elevationDeg: 0,
    directions: 2,
    pixelsPerMeter: 3000,
    cellW: 4096,
    cellH: 4096,
    yawOffsetDeg: cam.yawOffsetDeg,
    orthographic: cam.orthographic,
    fovDeg: cam.fovDeg,
    superSample: 1,
    ambient: .6,
    lightYaw: 20,
    lightFrame: 'world',
  };
  const args = lookArgs('W', draft, CAMERAS[0], STYLES[1]);
  for (
    const [flag, value] of [['--cell', '4096'], ['--projection', 'perspective'], ['--yaw', '90'], [
      '--ambient',
      '0.6',
    ], ['--light-frame', 'world']]
  ) {
    assertEquals(args[args.indexOf(flag) + 1], value);
  }
});

test('editing the same preset retains recorded settings the form does not expose', () => {
  const draft: LookDraft = {
    cameraPresetId: 'standard-30',
    stylePresetId: 'clean',
    elevationDeg: 30,
    directions: 8,
    pixelsPerMeter: 32,
    cellW: 64,
    cellH: 64,
  };
  const args = lookArgs('W', draft, CAMERAS[0], STYLES[1], {
    ...draft,
    cameraOverrides: { pivot: 'center' },
    overrides: { alpha: { mode: 'soft' } },
  });
  assertEquals(args, ['look', '--workspace', 'W']);
});
