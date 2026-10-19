import { strict as assert } from 'node:assert';
import { after, afterEach, beforeEach, type SuiteContext, type TestContext } from 'node:test';
import { disposeGpu } from '../../packages/render/dist/gpu.js';

// Materialize stdio before taking baselines. Node does not expose idle file descriptors here;
// the explicit sink/lock/crash regressions remain necessary alongside this handle guard.
void process.stdout;
void process.stderr;
const snapshots = new WeakMap<TestContext | SuiteContext, Map<string, number>>();
function resources(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of process.getActiveResourcesInfo()) {
    if (name === 'Immediate') continue; // the settling turn below owns one
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}
beforeEach((context) => snapshots.set(context, resources()));
afterEach(async (context) => {
  // close() callbacks run after libuv's check phase; allow a complete closing turn.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const before = snapshots.get(context)!;
  const extra = () => [...resources()].filter(([name, count]) => count > (before.get(name) ?? 0));
  // Windows socket closure can finish on a later I/O turn after its close callback.
  for (let turn = 0; turn < 10 && extra().length; turn++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const leaked = extra();
  assert.deepEqual(leaked, [], `Unreleased Node resources: ${JSON.stringify(leaked)}`);
});
after(disposeGpu);
