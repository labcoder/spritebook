/**
 * The Look stage's pure parts: the
 * resolved camera/style a control panel starts from, the `look` arg builder
 * (so the CLI twin IS the command), and the honest staleness statement.
 * react-free, so look_test.ts holds them.
 */

export interface CameraPresetRow {
  id: string;
  elevationDeg: number;
  directions: number;
  yawOffsetDeg: number;
  pixelsPerMeter: number;
  cellPx: { w: number; h: number };
  paddingPx: number;
  orthographic?: boolean;
  fovDeg?: number;
  pivot?: 'center' | 'feet-baseline' | { xPct: number; yPct: number };
}

export interface StylePresetRow {
  id: string;
  mode: string;
  maxColors?: number;
  outlineWidthPx?: number;
  superSample?: number;
  alphaMode?: string;
  lighting?: { direction: number[]; ambient: number; frame: string };
}

export interface LookRecord {
  cameraPresetId: string;
  cameraOverrides?: Record<string, unknown>;
  stylePresetId: string;
  overrides?: Record<string, unknown>;
}

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
  return { ...base, ...o };
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
  yawOffsetDeg?: number;
  orthographic?: boolean;
  fovDeg?: number;
  paddingPx?: number;
  superSample?: number;
  ambient?: number;
  lightYaw?: number;
  lightElevation?: number;
  lightFrame?: string;
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
  stored?: LookRecord,
): string[] {
  const a = ['look', '--workspace', dir];
  if (stored?.cameraPresetId !== draft.cameraPresetId) a.push('--camera', draft.cameraPresetId);
  if (stored?.stylePresetId !== draft.stylePresetId) a.push('--style', draft.stylePresetId);
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
  for (
    const [field, flag] of [
      ['yawOffsetDeg', 'yaw'],
      ['fovDeg', 'fov'],
      ['paddingPx', 'padding'],
      ['superSample', 'supersample'],
      ['ambient', 'ambient'],
      ['lightYaw', 'light-yaw'],
      ['lightElevation', 'light-elevation'],
      ['lightFrame', 'light-frame'],
    ] as const
  ) {
    if (draft[field] !== undefined) a.push(`--${flag}`, String(draft[field]));
  }
  if (draft.orthographic !== undefined) {
    a.push('--projection', draft.orthographic ? 'orthographic' : 'perspective');
  }
  return a;
}
