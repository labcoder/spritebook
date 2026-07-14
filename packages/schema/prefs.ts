/**
 * Machine-local GUI prefs — NEVER part of the project manifest or any project
 * I/O (Project/CharacterManifest schemas are strict, so a smuggled prefs key
 * fails validation loudly; see prefs test).
 */
import { z } from 'zod';

export const UiLayoutPrefsSchema = z.strictObject({
  theme: z.enum(['dark', 'light', 'system']),
  panels: z.record(
    z.string(),
    z.strictObject({
      widthPx: z.int().positive().optional(),
      collapsed: z.boolean().optional(),
    }),
  ),
  logDrawer: z.strictObject({
    heightPx: z.int().positive(),
    filter: z.enum(['all', 'warn', 'error']),
  }),
  stageRailCollapsed: z.boolean(),
});
export type UiLayoutPrefs = z.output<typeof UiLayoutPrefsSchema>;
