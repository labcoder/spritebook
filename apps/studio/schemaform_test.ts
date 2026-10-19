import { promises as fs } from 'node:fs';
import { test } from 'node:test';
/**
 * The D-009 form derivation, pinned against the REAL catalog: trellis2's
 * gen3d schema must yield renderable fields with the shipped defaults
 * resolved through the operation overlay, and only DIVERGENCE travels as
 * --adjust. A catalog change that breaks the form fails here first.
 */
import { assert, assertEquals } from '@std/assert';
import { adjustArg, resolveOpDefaults, schemaFields } from './src/schemaform.ts';

test('trellis2 gen3d: real schema -> renderable fields with shipped defaults', async () => {
  const catalog = JSON.parse(
    await fs.readFile(new URL('../../packages/registry/catalog/models.json', import.meta.url), 'utf8'),
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

test('only divergence travels: --adjust is empty at pure defaults', () => {
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

test('the gen form never offers a knob only retexture accepts', async () => {
  // Where the field report started: the form rendered the UNION of trellis2's
  // two operations, so `resolution` was an editable option on a GENERATE
  // screen — and the CLI then refused it. The form asks for gen3d's set now.
  const catalog = JSON.parse(
    await fs.readFile(new URL('../../packages/registry/catalog/models.json', import.meta.url), 'utf8'),
  );
  const v = catalog.models.find((m: { id: string }) => m.id === 'trellis2-4b').versions[0];
  const resolved = resolveOpDefaults(v.defaults, v.operationDefaults, 'gen3d');

  const union = schemaFields(v.paramsSchema, resolved).map((f) => f.key);
  assert(union.includes('resolution'), 'the union is what the form used to show');

  const gen = schemaFields(v.paramsSchema, resolved, v.operationParams.gen3d).map((f) => f.key);
  assert(!gen.includes('resolution'), `gen3d form offers only its own knobs: ${gen.join(', ')}`);
  for (const key of ['steps', 'decimationTarget', 'pipelineType']) {
    assert(gen.includes(key), `${key} is still on the form`);
  }
});

test('an absent knob set leaves every field, for single-operation backends', () => {
  const fields = schemaFields({ properties: { a: { type: 'integer' } } }, {}, undefined);
  assertEquals(fields.map((f) => f.key), ['a']);
});

test('unknown schema shapes degrade to labeled rows, never wrong widgets', () => {
  const fields = schemaFields(
    { properties: { weird: { type: 'array' }, plain: { type: 'boolean' } } },
    { weird: [1], plain: true },
  );
  assertEquals(fields.find((f) => f.key === 'weird')?.kind, 'unsupported');
  assertEquals(fields.find((f) => f.key === 'plain')?.kind, 'boolean');
});
