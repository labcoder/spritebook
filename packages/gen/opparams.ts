/**
 * The first lock on the params door, asked per OPERATION.
 *
 * A backend that does two jobs has one paramsSchema, so the union was what
 * both verbs validated against — and a knob belonging to the other operation
 * sailed through core only to be refused by the sidecar's own stricter schema,
 * one process later, with a sentence that named nothing. That is a real field
 * report: `gen --adjust resolution=1024` (a retexture knob, offered by the
 * Studio's options form, which renders the same union) died on "params must
 * NOT have additional properties".
 *
 * This is the one place both verbs ask, so the sentence stays identical
 * wherever it is read from.
 */
import {
  type Capability,
  type ModelVersion,
  operationsAccepting,
  paramsSchemaFor,
} from '@spritebook/schema';
import { coerceParams, propertyNames, validateParams } from '@spritebook/core';

export type OpParamsCheck =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; message: string };

/** Validate `params` for ONE operation, and say something useful when it fails.
 *
 * Returns the params to actually run with: `--adjust` JSON-parses its values,
 * so a digit-string enum arrives as a number and is coerced back here (see
 * coerceParams) rather than at every call site. */
export function checkOpParams(
  entryId: string,
  version: ModelVersion,
  op: Capability,
  params: Record<string, unknown>,
): OpParamsCheck {
  const schema = paramsSchemaFor(version, op);
  const coerced = coerceParams(schema, params);
  const check = validateParams(schema, coerced);
  if (check.ok) return { ok: true, params: coerced };

  const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  const unknown = Object.keys(coerced).filter((k) => !(k in props)).sort();
  // A knob the SAME backend accepts elsewhere is the interesting failure: the
  // user did not invent it, they read it off the model's own option list.
  const crossOp = unknown.filter((k) => operationsAccepting(version, k).length > 0);

  const parts: string[] = [];
  for (const key of crossOp) {
    parts.push(`"${key}" is a ${operationsAccepting(version, key).join(' and ')}-only knob`);
  }
  const plain = unknown.filter((k) => !crossOp.includes(k));
  if (plain.length > 0) parts.push(`unknown param(s) ${plain.join(', ')}`);
  if (unknown.length > 0) parts.push(`${op} accepts: ${propertyNames(schema).join(', ')}`);
  // core already words the value failures (ranges, enums) actionably; only its
  // unknown-key line is replaced here, having been said better above
  parts.push(...check.errors.filter((e) => !e.startsWith('unknown param(s) ')));

  return { ok: false, message: `Parameters rejected by "${entryId}": ${parts.join('; ')}` };
}
