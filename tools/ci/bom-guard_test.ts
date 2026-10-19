import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dependencyNames } from './bom-guard.ts';

test('BOM inventory includes all direct dependency sections and excludes internal packages', () => {
  assert.deepEqual(
    dependencyNames(JSON.stringify({
      name: 'not-a-dependency',
      dependencies: { zod: '4', '@spritebook/core': '0.1.0' },
      devDependencies: {
        '@std/assert': 'npm:@jsr/std__assert@1.0.19',
        zod: '4',
      },
      optionalDependencies: { native: '1' },
    })),
    ['zod', '@std/assert', 'native'],
  );
  assert.deepEqual(dependencyNames('{}'), []);
  assert.throws(() => dependencyNames('broken JSON'));
});
