/**
 * Core-side paramsSchema gate (P3-T2). Adapters declare JSON Schema (D-009 —
 * it validates job params AND drives GUI option forms); core validates BEFORE
 * a job request exists, so an invalid-params job never reaches the sidecar
 * (the roadmap's round-trip acceptance). ajv is exact-pinned; instances are
 * strict because every schema in the bundled roster is authored in-house — a
 * typoed keyword should fail loudly at validation time, not be ignored.
 */
import { Ajv, type ErrorObject } from 'ajv';
import type { JSONSchema } from '@spritebook/schema';

const ajv = new Ajv({ allErrors: true, strict: true });
const compiled = new WeakMap<JSONSchema, ReturnType<typeof ajv.compile>>();

export type ParamsCheck = { ok: true } | { ok: false; errors: string[] };

/** Validate `params` against an adapter's declared schema. Never throws on
 * bad PARAMS (that is the caller's error event); throws on a bad SCHEMA —
 * a malformed roster is a programming error, not user input. */
export function validateParams(schema: JSONSchema, params: Record<string, unknown>): ParamsCheck {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  if (validate(params)) return { ok: true };
  const errors = (validate.errors ?? []).map((e: ErrorObject) => {
    const where = e.instancePath === '' ? 'params' : `params${e.instancePath}`;
    return `${where} ${e.message ?? 'is invalid'}`;
  });
  return { ok: false, errors: errors.length ? errors : ['params are invalid'] };
}

/** Adapter defaults under explicit params — the merge core applies before the
 * gate, so defaults themselves are validated too. */
export function withDefaults(
  defaults: Record<string, unknown>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  return { ...defaults, ...params };
}
