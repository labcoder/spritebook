/**
 * The Look stage's pure parts: the elevation detents core's schema names, the
 * resolved camera/style a control panel starts from, the `look` arg builder
 * (so the CLI twin IS the command), and the honest staleness statement.
 * react-free, so look_test.ts holds them.
 */

/** Spread comparison views around the saved directions without inventing missing angles. */
export function comparisonDirections(directions: number[]): number[] {
  if (directions.length <= 3) return directions;
  return [
    directions[0]!,
    directions[Math.floor(directions.length / 4)]!,
    directions[Math.floor(directions.length / 2)]!,
  ];
}

export interface CameraPresetRow {
  id: string;
  elevationDeg: number;
  directions: number;
  yawOffsetDeg: number;
  pixelsPerMeter: number;
  cellPx: { w: number; h: number };
  paddingPx: number;
}

export interface StylePresetRow {
  id: string;
  mode: string;
  maxColors?: number;
  outlineWidthPx?: number;
  superSample?: number;
  alphaMode?: string;
}

export interface LookRecord {
  cameraPresetId: string;
  cameraOverrides?: Record<string, unknown>;
  stylePresetId: string;
  overrides?: Record<string, unknown>;
}

/**
 * The detents `CameraPresetSchema` documents: 15 | 26.565 (2:1) | 30 | 35.264
 * (iso). Any value in [0, 90) is legal — these are the ones worth one click.
 */
export const ELEVATION_DETENTS = [
  { deg: 15, label: 'low-15' },
  { deg: 26.565, label: '2:1' },
  { deg: 30, label: 'standard' },
  { deg: 35.264, label: 'isometric' },
] as const;

export const DIRECTION_CHOICES = [2, 4, 8, 16] as const;

/** The camera a bake would run with: preset defaults under recorded overrides. */
export function resolvedCamera(
  presets: CameraPresetRow[],
  look: LookRecord | undefined,
  fallbackId: string,
): CameraPresetRow | null {
  const id = look?.cameraPresetId ?? fallbackId;
  const base = presets.find((c) => c.id === id) ?? presets.find((c) => c.id === fallbackId);
  if (!base) return null;
  const o = (look?.cameraOverrides ?? {}) as Partial<CameraPresetRow>;
  return {
    ...base,
    ...(o.elevationDeg !== undefined ? { elevationDeg: o.elevationDeg } : {}),
    ...(o.directions !== undefined ? { directions: o.directions } : {}),
    ...(o.pixelsPerMeter !== undefined ? { pixelsPerMeter: o.pixelsPerMeter } : {}),
    ...(o.cellPx !== undefined ? { cellPx: o.cellPx } : {}),
    ...(o.paddingPx !== undefined ? { paddingPx: o.paddingPx } : {}),
  };
}

/** The style knobs a bake would run with: preset defaults under overrides. */
export function resolvedStyle(
  presets: StylePresetRow[],
  look: LookRecord | undefined,
  fallbackId: string,
): { row: StylePresetRow; maxColors?: number; outlineWidthPx?: number } | null {
  const id = look?.stylePresetId ?? fallbackId;
  const row = presets.find((s) => s.id === id) ?? presets.find((s) => s.id === fallbackId);
  if (!row) return null;
  const o = (look?.overrides ?? {}) as {
    quantize?: { maxColors?: number };
    outline?: { widthPx?: number };
  };
  return {
    row,
    maxColors: o.quantize?.maxColors ?? row.maxColors,
    outlineWidthPx: o.outline?.widthPx ?? row.outlineWidthPx,
  };
}

export interface LookDraft {
  cameraPresetId: string;
  stylePresetId: string;
  elevationDeg: number;
  directions: number;
  pixelsPerMeter: number;
  cellW: number;
  cellH: number;
  maxColors?: number;
  outlineWidthPx?: number;
}

/**
 * `look --workspace … [flags]` — only what DIVERGES from the presets travels,
 * the same rule the Generate form follows, so a twin never carries noise.
 */
export function lookArgs(
  dir: string,
  draft: LookDraft,
  cameraBase: CameraPresetRow | undefined,
  styleBase: StylePresetRow | undefined,
): string[] {
  const a = [
    'look',
    '--workspace',
    dir,
    '--camera',
    draft.cameraPresetId,
    '--style',
    draft.stylePresetId,
  ];
  if (cameraBase) {
    if (draft.elevationDeg !== cameraBase.elevationDeg) {
      a.push('--elevation', String(draft.elevationDeg));
    }
    if (draft.directions !== cameraBase.directions) {
      a.push('--directions', String(draft.directions));
    }
    if (draft.pixelsPerMeter !== cameraBase.pixelsPerMeter) {
      a.push('--ppm', String(draft.pixelsPerMeter));
    }
    if (draft.cellW !== cameraBase.cellPx.w || draft.cellH !== cameraBase.cellPx.h) {
      a.push(
        '--cell',
        draft.cellW === draft.cellH ? String(draft.cellW) : `${draft.cellW}x${draft.cellH}`,
      );
    }
  }
  if (styleBase) {
    if (draft.maxColors !== undefined && draft.maxColors !== styleBase.maxColors) {
      a.push('--colors', String(draft.maxColors));
    }
    if (draft.outlineWidthPx !== undefined && draft.outlineWidthPx !== styleBase.outlineWidthPx) {
      a.push('--outline', String(draft.outlineWidthPx));
    }
  }
  return a;
}

/**
 * What a look change costs, and it is all-or-nothing by construction: every
 * frame key embeds the whole recipe (pack/cache.ts), so ANY change stales the
 * entire last bake. Zero when nothing is baked — nothing to invalidate.
 */
export function staleFrames(
  bakedFrameCount: number,
  draft: LookDraft,
  recorded: LookDraft | null,
): number {
  if (recorded === null) return 0;
  const same = ([
    'cameraPresetId',
    'stylePresetId',
    'elevationDeg',
    'directions',
    'pixelsPerMeter',
    'cellW',
    'cellH',
    'maxColors',
    'outlineWidthPx',
  ] as const)
    .every((k) => draft[k] === recorded[k]);
  return same ? 0 : bakedFrameCount;
}
