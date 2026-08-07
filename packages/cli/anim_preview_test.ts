/**
 * `anim --preview` (D-038): the clip's motion before any bake, through the
 * bake's own retarget path. Pinned on the fixture pipeline end to end - the
 * glb must carry the named animation with real channels and the clip's own
 * duration, on the skinned character.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { NodeIO } from '@gltf-transform/core';
import { runCli } from './mod.ts';

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
const IMAGE = `${REPO}spikes/trellis2/refs/bulma-front.png`;
const BODY = `${REPO}packages/rig/bodies/ubc-male`;

Deno.test('anim --preview writes the retargeted clip onto the rigged character', async () => {
  const root = await Deno.makeTempDir({ prefix: 'sb-preview-' });
  const ws = `${root}/w`;
  try {
    for (
      const args of [
        [
          'gen',
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
    const doc = await new NodeIO().readBinary(await Deno.readFile(glbPath));
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

    // regenerate-on-demand: a second call overwrites without complaint (D-038)
    const again = await cli(['anim', '--preview', 'idle-loop', '--workspace', ws]);
    assertEquals(again.code, 0);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test('anim --preview refuses honestly without a canonical mesh', async () => {
  const root = await Deno.makeTempDir({ prefix: 'sb-preview-' });
  try {
    const r = await cli(['anim', '--preview', 'idle-loop', '--workspace', `${root}/empty`]);
    assert(r.code !== 0);
    assert(r.out.join('\n').includes('no canonical mesh'), 'names the missing prerequisite');
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
