import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * W5b: the thumbnail is core output through the real render pipeline, so it
 * is GPU-gated like every render test - and the skip says it asserted
 * NOTHING rather than printing a hollow ok.
 */
import { assert, assertEquals } from '@std/assert';
import { decode as decodePng } from 'fast-png';
import { tryGetGpu } from '@spritebook/render';
import { writeResultThumb } from './dist/thumb.js';

const MODEL = new URL('../anim/fixtures/humanoid-normal.glb', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');

test('writeResultThumb: a front-view lit png with a real subject', async (t) => {
  if ((await tryGetGpu()) === null) {
    t.skip('No WebGPU adapter');
    return;
  }
  const tmp = await fs.mkdtemp(join(tmpdir(), 'sb-thumbtest-'));
  try {
    const out = `${tmp}/thumb.png`;
    assertEquals(await writeResultThumb(MODEL, 1.75, out), 'written');
    const img = decodePng(new Uint8Array(await fs.readFile(out)));
    assertEquals([img.width, img.height], [192, 192]);
    const data = img.data as Uint8Array;
    let on = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) on++;
    const cov = on / (img.width * img.height);
    assert(cov > 0.05, `the subject fills the thumb (coverage ${(cov * 100).toFixed(1)}%)`);
  } finally {
    await fs.rm(tmp, { recursive: true }).catch(() => {});
  }
});

test('writeResultThumb: a missing model fails soft, never throws', async (t) => {
  if ((await tryGetGpu()) === null) {
    t.skip('No WebGPU adapter');
    return;
  }
  const tmp = await fs.mkdtemp(join(tmpdir(), 'sb-thumbtest-'));
  try {
    assertEquals(await writeResultThumb(`${tmp}/absent.glb`, 1.7, `${tmp}/t.png`), 'failed');
  } finally {
    await fs.rm(tmp, { recursive: true }).catch(() => {});
  }
});
