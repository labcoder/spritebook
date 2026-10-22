import { test } from 'node:test';
import { assertEquals } from '@std/assert';
import { discoverableModels, generatorSelection } from './src/genmodels.ts';

test('production discovery excludes fixtures; development keeps them last without changing the catalog', () => {
  const catalog = [{ id: 'fixture-gen' }, { id: 'trellis2' }, { id: 'pixal3d' }];
  assertEquals(discoverableModels(catalog, false).map((m) => m.id), ['trellis2', 'pixal3d']);
  assertEquals(discoverableModels(catalog, true).map((m) => m.id), [
    'trellis2',
    'pixal3d',
    'fixture-gen',
  ]);
  assertEquals(catalog[0]?.id, 'fixture-gen');
});

test('generation preserves an explicit choice and otherwise selects an installed visible model', () => {
  const models = [
    { id: 'trellis2', versions: [{ installed: false }] },
    { id: 'pixal3d', versions: [{ installed: true }] },
  ];
  assertEquals(generatorSelection(null, ''), '');
  assertEquals(generatorSelection([], 'fixture-gen'), '');
  assertEquals(generatorSelection(models, 'fixture-gen'), 'pixal3d');
  assertEquals(generatorSelection(models, 'trellis2'), 'trellis2');
  assertEquals(generatorSelection([models[0]!], ''), 'trellis2');
  assertEquals(
    generatorSelection([models[0]!, { id: 'fixture-gen', versions: [{ installed: true }] }], ''),
    'trellis2',
  );
});
