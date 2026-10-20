import { promises as fs } from 'node:fs';
/**
 * Project pins (D-009): thin IO over ProjectPinsSchema. The pins document
 * maps model/pack ids to exact versions; rendererVersion remains reserved.
 * Actual cache identity uses renderSignature() (D-011). Execution policy reads
 * model/pack pins before use; byte-deterministic
 * reading and writing of the document live here.
 */
import { canonicalJson, parseWith, type ProjectPins, ProjectPinsSchema } from '@spritebook/schema';

/** Read + schema-validate a pins file. Missing or broken files throw actionably. */
export async function readPins(path: string): Promise<ProjectPins> {
  const text = await fs.readFile(path, 'utf8').catch((err) => {
    throw new Error(`cannot read pins file ${path}: ${message(err)}`);
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${message(err)}`);
  }
  return parseWith(ProjectPinsSchema, raw, `ProjectPins (${path})`);
}

/** Validate, then write canonically — a pins file on disk is always schema-true bytes. */
export async function writePins(path: string, pins: ProjectPins): Promise<void> {
  const valid = parseWith(ProjectPinsSchema, pins, 'ProjectPins (writePins)');
  await fs.writeFile(path, canonicalJson(valid));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
