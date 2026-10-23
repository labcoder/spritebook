import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRenderSize } from './dist/renderer.js';

test('capture limits allow 4K and reject oversized supersampling or padded readback', () => {
  const limits = { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024 };
  assert.doesNotThrow(() => assertRenderSize(limits, 4096, 4096));
  assert.doesNotThrow(() => assertRenderSize(limits, 8192, 8192));
  assert.throws(() => assertRenderSize(limits, 16384, 16384), /Reduce supersampling/);
  assert.throws(
    () => assertRenderSize({ ...limits, maxBufferSize: 50000 }, 100, 100),
    /bytes per buffer/,
  );
});
