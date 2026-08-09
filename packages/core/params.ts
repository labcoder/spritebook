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

/** Validate `params` against an adapter's declared schema. NEVER throws: bad
 * params are the caller's error event, and a bad SCHEMA is one too — the
 * schema arrives from the sidecar HANDSHAKE (validated only as a JSON
 * record), so an ajv-strict rejection here must not detonate the choke point
 * mid-generator (P3-T2 review P2-2). */
export function validateParams(schema: JSONSchema, params: Record<string, unknown>): ParamsCheck {
  let validate = compiled.get(schema);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch (e) {
      return {
        ok: false,
        errors: [
          `the adapter declared an invalid paramsSchema: ${
            e instanceof Error ? e.message : String(e)
          }`,
        ],
      };
    }
    compiled.set(schema, validate);
  }
  if (validate(params)) return { ok: true };
  const raw = validate.errors ?? [];
  const errors: string[] = [];

  // ajv names the offending key in `params.additionalProperty` and NOWHERE in
  // the message, so the sentence a user actually reads is "params must NOT have
  // additional properties" — true, unactionable, and the reason a field report
  // reached the maintainer. One line names every unknown key and the roster it
  // could have come from, worded like the sidecar's own validator so the two
  // locks on this door read the same.
  const unknown = raw
    .filter((e) => e.keyword === 'additionalProperties')
    .map((e) => String((e.params as { additionalProperty?: unknown }).additionalProperty))
    .sort();
  if (unknown.length > 0) {
    errors.push(
      `unknown param(s) ${unknown.join(', ')}; allowed: ${propertyNames(schema).join(', ')}`,
    );
  }

  for (const e of raw as ErrorObject[]) {
    if (e.keyword === 'additionalProperties') continue;
    const where = e.instancePath === '' ? 'params' : `params${e.instancePath}`;
    // an enum failure has the same problem in miniature: the allowed values are
    // in `params.allowedValues`, never in the message
    const allowed = (e.params as { allowedValues?: unknown[] }).allowedValues;
    const detail = e.keyword === 'enum' && Array.isArray(allowed)
      ? `must be one of ${allowed.map((v) => JSON.stringify(v)).join(', ')}`
      : e.message ?? 'is invalid';
    errors.push(`${where} ${detail}`);
  }
  return { ok: false, errors: errors.length ? errors : ['params are invalid'] };
}

/** The keys a schema describes, sorted — the roster an error message quotes. */
export function propertyNames(schema: JSONSchema): string[] {
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  return props ? Object.keys(props).sort() : [];
}

/** Nudge values toward the types the schema asks for.
 *
 * `--adjust` JSON-parses what it is given, so a digit-string enum arrives as a
 * number: trellis2's `pipelineType` accepts "512" | "1024" | "1024_cascade",
 * and `--adjust pipelineType=1024` produced the NUMBER 1024, which no enum
 * member equals. The knob was unreachable from the CLI for as long as it has
 * existed.
 *
 * Deliberately one-way and narrow: where the schema asks for a string, a number
 * or a boolean is stringified. Nothing else moves — a key the schema does not
 * describe stays exactly as the caller typed it, so the unknown-key error above
 * still names it, and no string is ever quietly parsed into a number (that
 * direction hides typos instead of fixing them). */
export function coerceParams(
  schema: JSONSchema,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const props = (schema as { properties?: Record<string, { type?: unknown }> }).properties;
  if (!props) return params;
  const out: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(out)) {
    if (props[key]?.type !== 'string') continue;
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

/** Adapter defaults under explicit params — the merge core applies before the
 * gate, so defaults themselves are validated too. */
export function withDefaults(
  defaults: Record<string, unknown>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  return { ...defaults, ...params };
}
