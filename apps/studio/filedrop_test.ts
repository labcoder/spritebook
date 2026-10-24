import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listenFileDrop } from './src/filedrop.ts';

test('file-drop teardown ignores callbacks after unmount and unsubscribes even when registration resolves late', async () => {
  for (const late of [false, true]) {
    let deliver!: (paths: string[]) => void;
    let registered!: (stop: () => void) => void;
    let stopped = 0;
    const received: string[][] = [];
    const cleanup = listenFileDrop(
      (receive) => {
        deliver = receive;
        return new Promise((resolve) => registered = resolve);
      },
      (paths) => received.push(paths),
      (error) => {
        throw error;
      },
    );
    await Promise.resolve();
    deliver(['before.png']);
    if (late) cleanup();
    registered(() => stopped++);
    await new Promise<void>((resolve) => setImmediate(resolve));
    cleanup();
    cleanup();
    deliver(['after.png']);
    assert.deepEqual(received, [['before.png']]);
    assert.equal(stopped, 1);
  }
  const failures: unknown[] = [];
  const cleanup = listenFileDrop(async () => {
    throw new Error('registration failed');
  }, () => {
    assert.fail('rejected registration must not deliver files');
  }, (error) => failures.push(error));
  await new Promise<void>((resolve) => setImmediate(resolve));
  cleanup();
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /registration failed/);
});
