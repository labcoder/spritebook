/**
 * The D-009 form derivation, pinned against the REAL catalog: trellis2's
 * gen3d schema must yield renderable fields with the shipped defaults
 * resolved through the operation overlay, and only DIVERGENCE travels as
 * --adjust. A catalog change that breaks the form fails here first.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { adjustArg, resolveOpDefaults, schemaFields } from './src/schemaform.ts';

Deno.test('trellis2 gen3d: real schema -> renderable fields with shipped defaults', async () => {
  const catalog = JSON.parse(
    await Deno.readTextFile(
      new URL('../../packages/registry/catalog/models.json', import.meta.url),
    ),
  );
  const t2 = catalog.models.find((m: { id: string }) => m.id === 'trellis2-4b');
  const v = t2.versions[0];
  const resolved = resolveOpDefaults(v.defaults, v.operationDefaults, 'gen3d');
  assertEquals(resolved.textureGuidance, 3.5, 'the A1 pick reaches the form');
  assertEquals(resolved.steps, 12, 'the C1 default reaches the form');

  const fields = schemaFields(v.paramsSchema, resolved);
  assert(fields.length >= 5, `real schema yields fields (${fields.length})`);
  for (const f of fields) {
    assert(f.kind !== 'unsupported', `${f.key} renders a real widget (${JSON.stringify(f)})`);
  }
  const steps = fields.find((f) => f.key === 'steps');
  assert(steps && (steps.kind === 'integer' || steps.kind === 'number'));
  assertEquals(steps.defaultValue, 12);
});

Deno.test('only divergence travels: --adjust is empty at pure defaults', () => {
  const resolved = { steps: 12, guidanceStrength: 7.5, pipelineType: '512' };
  assertEquals(adjustArg({}, resolved), null);
  assertEquals(adjustArg({ steps: 12 }, resolved), null, 'explicit default is still default');
  assertEquals(adjustArg({ steps: 20 }, resolved), 'steps=20');
  assertEquals(
    adjustArg({ steps: 20, pipelineType: '1024' }, resolved),
    'steps=20,pipelineType=1024',
  );
  assertEquals(adjustArg({ steps: undefined }, resolved), null, 'cleared field does not travel');
});

Deno.test('unknown schema shapes degrade to labeled rows, never wrong widgets', () => {
  const fields = schemaFields(
    { properties: { weird: { type: 'array' }, plain: { type: 'boolean' } } },
    { weird: [1], plain: true },
  );
  assertEquals(fields.find((f) => f.key === 'weird')?.kind, 'unsupported');
  assertEquals(fields.find((f) => f.key === 'plain')?.kind, 'boolean');
});
