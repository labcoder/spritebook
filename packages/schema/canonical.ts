/**
 * Canonical JSON + validation error surface.
 *
 * Byte-determinism law: every persisted manifest is written as canonical JSON
 * (recursively sorted keys, compact separators, trailing newline). The T2
 * acceptance test round-trips every fixture: bytes -> parse+validate ->
 * canonicalJson -> identical bytes.
 */
import { z } from 'zod';

/** Deterministic serialization: sorted keys, compact, trailing '\n'. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value)) + '\n';
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v !== null && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortDeep(src[k]);
    return out;
  }
  return v;
}

/** Thrown by parseWith — message is the actionable, path-bearing report. */
export class SchemaError extends Error {
  override name = 'SchemaError';
}

/**
 * Validate `data` against `schema`; on failure throw a SchemaError whose
 * message names the entity and every offending path (z.prettifyError).
 */
export function parseWith<S extends z.ZodType>(
  schema: S,
  data: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new SchemaError(`invalid ${what}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
