import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the resource guard accepts cleanup and rejects a referenced timer', () => {
  for (const leak of [false, true]) {
    const child = spawnSync(process.execPath, [
      '--import', new URL('./setup.ts', import.meta.url).href,
      '--test', '--test-reporter=tap', fileURLToPath(new URL('./lifecycle.fixture.ts', import.meta.url)),
    ], {
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, SPRITEBOOK_LEAK_FIXTURE: leak ? '1' : '' },
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    if (child.error) throw child.error;
    assert.equal(child.status, leak ? 1 : 0, child.stdout + child.stderr);
    if (leak) assert.match(child.stdout + child.stderr, /Unreleased Node resources.*Timeout/);
  }
});
