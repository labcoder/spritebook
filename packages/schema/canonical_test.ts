import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { z } from 'zod';
import { canonicalJson, parseWith, SchemaError } from './canonical.ts';

Deno.test('canonicalJson is key-order independent (recursively)', () => {
  const a = { b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } };
  const b = { a: { c: 3, d: [{ y: 2, z: 1 }] }, b: 1 };
  assertEquals(canonicalJson(a), canonicalJson(b));
  assertEquals(canonicalJson(a), '{"a":{"c":3,"d":[{"y":2,"z":1}]},"b":1}\n');
});

Deno.test('canonicalJson preserves array order and ends with a newline', () => {
  const s = canonicalJson([3, 1, 2]);
  assertEquals(s, '[3,1,2]\n');
  assert(s.endsWith('\n'));
});

Deno.test('parseWith throws SchemaError naming the entity and the path', () => {
  const schema = z.strictObject({ n: z.int().positive() });
  const err = assertThrows(
    () => parseWith(schema, { n: -1 }, 'TestEntity'),
    SchemaError,
  );
  assert(err.message.includes('TestEntity'), 'names the entity');
  assert(err.message.includes('n'), 'names the offending path');
});
