import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * `anim --preview` (D-038): the clip's motion before any bake, through the
 * bake's own retarget path. Pinned on the fixture pipeline end to end - the
 * glb must carry the named animation with real channels and the clip's own
 * duration, on the skinned character.
 */
import { assert, assertEquals } from '@std/assert';
import { NodeIO } from '@gltf-transform/core';
import { runCli } from './dist/mod.js';

function io() {
  const out: string[] = [];
  return { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), out };
}
async function cli(args: string[]): Promise<{ code: number; out: string[] }> {
  const o = io();
  const code = await runCli(args, o);
  return { code, out: o.out };
}

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const IMAGE = `${REPO}tests/fixtures/bulma-front.png`;
const BODY = 'ubc-male';

test('anim --preview writes the retargeted clip onto the rigged character', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'sb-preview-'));
  const ws = `${root}/w`;
  try {
    for (
      const args of [
        ['models', 'install', 'fixture-gen', '--models-dir', `${root}/models`],
        [
          'gen',
          '--models-dir',
          `${root}/models`,
          '--workspace',
          ws,
          '--character',
          'pv',
          '--image',
          IMAGE,
          '--model',
          'fixture-gen',
          '--seed',
          '1',
        ],
        ['pick', '--workspace', ws, '--result', 'r1'],
        [
          'rig',
          '--track-a',
          '--workspace',
          ws,
          '--body',
          BODY,
          '--model',
          `${ws}/canonical/model.glb`,
          '--out',
          `${ws}/rig`,
        ],
      ]
    ) {
      const r = await cli(args);
      assertEquals(r.code, 0, `${args[0]}: ${r.out.slice(-4).join('\n')}`);
    }

    const r = await cli(['anim', '--preview', 'idle-loop', '--workspace', ws]);
    assertEquals(r.code, 0, r.out.slice(-4).join('\n'));

    const glbPath = `${ws}/anim/preview-idle-loop.glb`;
    const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(glbPath)));
    const anim = doc.getRoot().listAnimations().find((a) => a.getName() === 'idle-loop');
    assert(anim, 'the animation carries the clip id');
    const channels = anim.listChannels();
    assert(channels.length > 10, `real channels, not a stub (${channels.length})`);
    const times = channels[0]!.getSampler()!.getInput()!.getArray()!;
    assert(times[times.length - 1]! > 1, 'the clip keeps its own duration');
    assertEquals(doc.getRoot().listSkins().length, 1, 'the character stays skinned');
    // every channel drives a node that exists - retarget maps by name and
    // unmapped joints are dropped, never dangled
    for (const ch of channels) assert(ch.getTargetNode() !== null);

    // W4c: SEPARATE vertex layout, pinned at the byte level - interleaved
    // mixed-type buffers defeat the studio viewport's WebGPU vertex formats
    // (the 'unorm32x4' empty canvas), so a per-attribute bufferView may
    // stride at most one element (float32 VEC4 = 16 bytes)
    const glbBytes = new Uint8Array(await fs.readFile(glbPath));
    const dv = new DataView(glbBytes.buffer, glbBytes.byteOffset);
    const jsonLen = dv.getUint32(12, true);
    const gjson = JSON.parse(new TextDecoder().decode(glbBytes.subarray(20, 20 + jsonLen)));
    for (const bv of gjson.bufferViews ?? []) {
      assert(
        (bv.byteStride ?? 0) <= 16,
        `interleaved bufferView: stride ${bv.byteStride} spans multiple attributes`,
      );
    }

    // regenerate-on-demand: a second call overwrites without complaint (D-038)
    const again = await cli(['anim', '--preview', 'idle-loop', '--workspace', ws]);
    assertEquals(again.code, 0);
  } finally {
    await fs.rm(root, { recursive: true }).catch(() => {});
  }
});

test('anim --preview refuses honestly without a canonical mesh', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'sb-preview-'));
  try {
    const r = await cli(['anim', '--preview', 'idle-loop', '--workspace', `${root}/empty`]);
    assert(r.code !== 0);
    assert(r.out.join('\n').includes('no canonical mesh'), 'names the missing prerequisite');
  } finally {
    await fs.rm(root, { recursive: true }).catch(() => {});
  }
});
