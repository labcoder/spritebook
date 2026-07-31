/**
 * The D-009 options form, derived: a catalog paramsSchema (JSON Schema) plus
 * the resolved per-operation defaults become renderable fields. Pure and
 * dependency-free; schemaform_test.ts pins the derivation against the REAL
 * trellis2 schema so a catalog change that breaks the form fails a test, not
 * a user.
 *
 * Only what current catalogs use is supported (number/integer/string/boolean,
 * enum, min/max); anything else degrades to a labeled read-only row rather
 * than a wrong widget.
 */

export interface SchemaField {
  key: string;
  kind: 'number' | 'integer' | 'string' | 'boolean' | 'enum' | 'unsupported';
  enumValues?: string[];
  min?: number;
  max?: number;
  /** the resolved default for the chosen operation — the form's initial value */
  defaultValue: unknown;
  description?: string;
}

interface JsonSchemaish {
  properties?: Record<string, Record<string, unknown>>;
}

export function resolveOpDefaults(
  defaults: Record<string, unknown>,
  operationDefaults: Record<string, Record<string, unknown>> | undefined,
  op: string,
): Record<string, unknown> {
  return { ...defaults, ...(operationDefaults?.[op] ?? {}) };
}

export function schemaFields(
  schema: unknown,
  resolvedDefaults: Record<string, unknown>,
): SchemaField[] {
  const props = (schema as JsonSchemaish | null)?.properties ?? {};
  return Object.entries(props).map(([key, p]) => {
    const type = typeof p.type === 'string' ? p.type : undefined;
    const enumValues = Array.isArray(p.enum) ? p.enum.map(String) : undefined;
    const kind: SchemaField['kind'] = enumValues
      ? 'enum'
      : type === 'number' || type === 'integer' || type === 'string' || type === 'boolean'
      ? type
      : 'unsupported';
    return {
      key,
      kind,
      ...(enumValues ? { enumValues } : {}),
      ...(typeof p.minimum === 'number' ? { min: p.minimum } : {}),
      ...(typeof p.maximum === 'number' ? { max: p.maximum } : {}),
      defaultValue: resolvedDefaults[key],
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
    };
  });
}

/** Only values that DIVERGE from the resolved defaults become --adjust. */
export function adjustArg(
  values: Record<string, unknown>,
  resolvedDefaults: Record<string, unknown>,
): string | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === '' || v === resolvedDefaults[k]) continue;
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return parts.length > 0 ? parts.join(',') : null;
}
