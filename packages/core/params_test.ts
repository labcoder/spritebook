/**
 * The params gate's MESSAGES, and the one coercion that keeps a knob reachable.
 *
 * A rejection here is the last thing a user sees before their job dies, so the
 * sentence is the feature: it must name the key it refused and the roster it
 * could have come from. The field report that produced these tests was a real
 * run of `gen --adjust decimationTarget=800000,resolution=1024,steps=25` that
 * failed with "params must NOT have additional properties" and left the user
 * with no way to learn which of the three was wrong.
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { coerceParams, propertyNames, validateParams } from './params.ts';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    steps: { type: 'integer', minimum: 1, maximum: 50 },
    decimationTarget: { type: 'integer', minimum: 10000, maximum: 2000000 },
    pipelineType: { type: 'string', enum: ['512', '1024', '1024_cascade'] },
    lowVram: { type: 'boolean' },
  },
};

Deno.test('an unknown param is named, with the roster it could have come from', () => {
  const check = validateParams(SCHEMA, { steps: 25, resolution: 1024 });
  assert(!check.ok);
  assertEquals(check.errors, [
    'unknown param(s) resolution; allowed: decimationTarget, lowVram, pipelineType, steps',
  ]);
});

Deno.test('several unknown params arrive as ONE sentence, sorted', () => {
  const check = validateParams(SCHEMA, { quality: 'high', resolution: 1024 });
  assert(!check.ok);
  assertEquals(check.errors.length, 1);
  assertStringIncludes(check.errors[0], 'unknown param(s) quality, resolution;');
});

Deno.test('the wording matches the sidecar validator, the other lock on this door', () => {
  // sidecar/spritebook_sidecar/adapters/__init__.py:
  //   f"unknown param(s) {', '.join(unknown)}; allowed: {', '.join(sorted(props))}"
  const check = validateParams(SCHEMA, { resolution: 1024 });
  assert(!check.ok);
  assert(
    /^unknown param\(s\) .+; allowed: .+$/.test(check.errors[0]),
    `core must speak the sidecar's sentence, got: ${check.errors[0]}`,
  );
});

Deno.test('an enum failure lists the values it would have taken', () => {
  const check = validateParams(SCHEMA, { pipelineType: '2048' });
  assert(!check.ok);
  assertEquals(check.errors, [
    'params/pipelineType must be one of "512", "1024", "1024_cascade"',
  ]);
});

Deno.test("range failures keep ajv's own wording, which was already actionable", () => {
  const check = validateParams(SCHEMA, { steps: 500 });
  assert(!check.ok);
  assertStringIncludes(check.errors[0], 'params/steps must be <= 50');
});

Deno.test('unknown keys and bad values are reported together, not one per run', () => {
  const check = validateParams(SCHEMA, { resolution: 1024, steps: 500 });
  assert(!check.ok);
  assertEquals(check.errors.length, 2);
  assertStringIncludes(check.errors[0], 'unknown param(s) resolution');
  assertStringIncludes(check.errors[1], 'params/steps');
});

Deno.test('a digit-string enum is reachable from --adjust, which JSON-parses', () => {
  // `--adjust pipelineType=1024` hands core the NUMBER 1024
  const raw = { pipelineType: 1024 };
  assert(!validateParams(SCHEMA, raw).ok, 'the number is what used to be refused');
  const coerced = coerceParams(SCHEMA, raw);
  assertEquals(coerced, { pipelineType: '1024' });
  assert(validateParams(SCHEMA, coerced).ok);
});

Deno.test('coercion is one-way: nothing is parsed INTO a number', () => {
  // a typo must still fail loudly rather than be repaired into a wrong value
  const coerced = coerceParams(SCHEMA, { steps: '25', lowVram: 'yes' });
  assertEquals(coerced, { steps: '25', lowVram: 'yes' });
  assert(!validateParams(SCHEMA, coerced).ok);
});

Deno.test('coercion leaves undescribed keys alone, so the error can still name them', () => {
  const coerced = coerceParams(SCHEMA, { resolution: 1024 });
  assertEquals(coerced, { resolution: 1024 });
  assertStringIncludes(validateParams(SCHEMA, coerced).ok ? '' : 'unknown', 'unknown');
});

Deno.test('propertyNames is the roster, sorted and stable', () => {
  assertEquals(propertyNames(SCHEMA), [
    'decimationTarget',
    'lowVram',
    'pipelineType',
    'steps',
  ]);
  assertEquals(propertyNames({ type: 'object' }), []);
});
