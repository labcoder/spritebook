/**
 * The built-in camera presets, and the one place a preset id becomes a camera
 * (D-029).
 *
 * ## Why this module exists
 *
 * `CharacterManifest.look.cameraPresetId` has been in the schema since P1-T2
 * and could not be resolved by anything: no table, no registry, and although
 * `ProjectSchema` carries a `cameraPresets` array, nothing in the tree loads a
 * project file. The only producer of a CameraPreset was `cameraFromFlags()` in
 * the CLI, which SYNTHESIZED an id (`cli-e30x8`) from the flags it had just
 * read — a name that resolves to nothing, stored in the bake manifest as if it
 * did. So a character could declare its own framing and the bake could not
 * honour it. `render/contracts.ts` already promises "Core resolves the preset
 * id against the project manifest"; this is the half of that promise that can
 * be kept without a project loader, and `resolveCamera` is where the loader
 * plugs in when there is one (see "Recorded, not done" in D-029).
 *
 * ## Why the presets differ in one field
 *
 * The PRD's Look stage (docs/prd.md, "04 Look") describes an elevation slider
 * with detents at 15 / 26.6 / 30 / 35.3 degrees, and puts direction count, px/m
 * and cell size beside it as INDEPENDENT controls. So the detents are the
 * preset table and the other three are overrides — bundling a cell size into
 * "isometric" would make choosing an angle silently resize the sheet.
 *
 * `standard-30` is field-identical to the CLI's flag defaults, so the two
 * resolution paths agree on everything but the name.
 */
import {
  type CameraOverrides,
  type CameraPreset,
  CameraPresetSchema,
  parseWith,
} from '@spritebook/schema';

/**
 * Shared by every detent — see the module note on why these are not per-preset.
 *
 * `cellPx` is 96, not 64, because of D-032: 64 was sized for an IDLE POSE and
 * SpriteBook's output is animated sheets. Measured on the Track A body at
 * ppm 32 across a six-clip set (`tools/proofs/framing.ts`): an idle needs
 * 37 x 63 px and fits 64 comfortably, while the clip set reaches 37 px left and
 * 36 px right of the pivot and needs **85 x 73** — so every animated character
 * clipped on the shipped default, which is exactly what the 100-character
 * pivot found on 100 of 100. 96 holds it with 11 px of width to spare.
 *
 * The measurement is ONE body and ONE clip set; a sword-combo pack reaches
 * further and `--cell` stays the escape hatch. Raising the cell rather than
 * lowering `pixelsPerMeter` is deliberate: px/m is the world-locked ruler the
 * whole roster shares, and shrinking the character to fit the frame would trade
 * a framing bug for a detail one.
 */
const COMMON = {
  directions: 8,
  yawOffsetDeg: 0,
  pixelsPerMeter: 32,
  cellPx: { w: 96, h: 96 },
  paddingPx: 6,
  pivot: 'feet-baseline',
  orthographic: true,
} as const;

/** A low, nearly side-on angle — the most character silhouette per pixel. */
export const LOW_15: CameraPreset = parseWith(CameraPresetSchema, {
  id: 'low-15',
  elevationDeg: 15,
  ...COMMON,
}, 'CameraPreset low-15');

/** Classic 2:1 pixel-art projection: atan(0.5) = 26.565°, so 2 px across per 1 px down. */
export const TWO_TO_ONE: CameraPreset = parseWith(CameraPresetSchema, {
  id: 'two-to-one',
  elevationDeg: 26.565,
  ...COMMON,
}, 'CameraPreset two-to-one');

/** The default. Field-identical to the CLI's flag defaults. */
export const STANDARD_30: CameraPreset = parseWith(CameraPresetSchema, {
  id: 'standard-30',
  elevationDeg: 30,
  ...COMMON,
}, 'CameraPreset standard-30');

/** True isometric: atan(1/sqrt(2)) = 35.264°, the angle a cube's diagonal makes. */
export const ISOMETRIC: CameraPreset = parseWith(CameraPresetSchema, {
  id: 'isometric',
  elevationDeg: 35.264,
  ...COMMON,
}, 'CameraPreset isometric');

export const CAMERA_PRESETS: Record<string, CameraPreset> = {
  'low-15': LOW_15,
  'two-to-one': TWO_TO_ONE,
  'standard-30': STANDARD_30,
  'isometric': ISOMETRIC,
};

/** What `resolveCamera` falls back to, and what the `bake` flag defaults describe. */
export const DEFAULT_CAMERA_PRESET_ID = 'standard-30';

/**
 * Resolve a preset id and optional overrides into the camera a bake runs with.
 *
 * Overrides are a SHALLOW merge, so `cellPx` replaces wholesale — `{ w: 128 }`
 * alone is not a legal override, and the schema says so rather than quietly
 * producing a cell with no height.
 *
 * The merged result is re-validated, not merely spread: `CameraPresetSchema`
 * refuses elevation 90 (the ortho framing solver degenerates when world-up is
 * parallel to the view) and non-{2,4,8,16} direction counts, and an override
 * arriving from a hand-edited manifest can carry either. Validating only the
 * preset and only the override would let their COMBINATION be illegal.
 */
export function resolveCamera(
  presetId: string = DEFAULT_CAMERA_PRESET_ID,
  overrides?: CameraOverrides,
): CameraPreset {
  // Object.hasOwn, not a bare index: `cameraPresetId: "constructor"` would
  // otherwise find Object.prototype.constructor and die spreading a function,
  // the same prototype-chain trap the CLI's `--style` lookup already guards.
  if (!Object.hasOwn(CAMERA_PRESETS, presetId)) {
    throw new Error(
      `Unknown camera preset "${presetId}" - available: ${
        Object.keys(CAMERA_PRESETS).sort().join(', ')
      }`,
    );
  }
  const base = CAMERA_PRESETS[presetId];
  if (overrides === undefined) return base;
  // an explicit `undefined` in the override object must not erase a field on
  // the way through the spread — it means "not overridden", not "unset"
  const applied: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) applied[k] = v;
  return parseWith(
    CameraPresetSchema,
    { ...base, ...applied },
    `CameraPreset "${presetId}" with overrides`,
  );
}
