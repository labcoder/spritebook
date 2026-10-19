import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * `anim --enable/--disable` (P4-T2): binding decisions as journaled patches.
 * Enable resolves the pack from the installed packs and merges position-
 * stable like the bake does; disable KEEPS the numbers (a choice to leave a
 * clip out is still a choice); unknown clips are refused naming the fix; and
 * one undo takes any of it back — that is the whole point of the journal.
 */
import { assert, assertEquals } from '@std/assert';
import { createWorkspace } from '@spritebook/core';
import { runCli } from './dist/mod.js';

function io() {
  const out: string[] = [];
  return { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), out };
}

async function rig(): Promise<{ ws: string; tmp: string }> {
  const tmp = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  const ws = `${tmp}/sprout`;
  await createWorkspace({
    workspace: ws,
    characterId: 'sprout',
    displayName: 'sprout',
    source: { kind: 'image', originalFilename: 'x.png', sha256: 'a'.repeat(64) },
  });
  return { ws, tmp };
}

test('enable resolves the pack, records the binding, and undo reverts it', async () => {
  const { ws, tmp } = await rig();
  try {
    const o = io();
    const code = await runCli(
      ['anim', '--enable', 'idle-loop:6@1.5!hold', '--workspace', ws, '--json'],
      o,
    );
    assertEquals(code, 0, o.out.join('\n'));
    const doc = JSON.parse(o.out.at(-1)!);
    assertEquals(doc.animationSet, [{
      clipId: 'idle-loop',
      packId: 'ual',
      enabled: true,
      frames: 6,
      speed: 1.5,
      holdLast: true,
    }]);

    const undo = await runCli(['undo', '--manifest', `${ws}/character.json`], io());
    assertEquals(undo, 0);
    const manifest = JSON.parse(await fs.readFile(`${ws}/character.json`, 'utf8'));
    assertEquals(manifest.animationSet, undefined, 'the decision is fully taken back');
  } finally {
    await fs.rm(tmp, { recursive: true });
  }
});

test('disable keeps the numbers; re-enable updates in place', async () => {
  const { ws, tmp } = await rig();
  try {
    await runCli(
      ['anim', '--enable', 'idle-loop:6,walk-loop:8@2', '--workspace', ws, '--json'],
      io(),
    );
    const o = io();
    await runCli(['anim', '--disable', 'walk-loop', '--workspace', ws, '--json'], o);
    let set = JSON.parse(o.out.at(-1)!).animationSet;
    assertEquals(set[1], {
      clipId: 'walk-loop',
      packId: 'ual',
      enabled: false,
      frames: 8,
      speed: 2,
      holdLast: false,
    }, 'disabled, numbers kept');

    const o2 = io();
    await runCli(['anim', '--enable', 'idle-loop:4', '--workspace', ws, '--json'], o2);
    set = JSON.parse(o2.out.at(-1)!).animationSet;
    assertEquals(set[0].frames, 4, 'updated in place');
    assertEquals(set[0].clipId, 'idle-loop', 'position stable');
    assertEquals(set.length, 2);
  } finally {
    await fs.rm(tmp, { recursive: true });
  }
});

test('unknown clips and absent bindings refuse with the fix named', async () => {
  const { ws, tmp } = await rig();
  try {
    const o = io();
    const code = await runCli(
      ['anim', '--enable', 'not-a-clip:6', '--workspace', ws, '--json'],
      o,
    );
    assertEquals(code, 1);
    assert(o.out.join('\n').includes('anim --list'), 'points at the list');

    const o2 = io();
    const code2 = await runCli(['anim', '--disable', 'idle-loop', '--workspace', ws], o2);
    assertEquals(code2, 1);
    assert(o2.out.join('\n').includes('(none)'), 'names the (empty) binding set');
  } finally {
    await fs.rm(tmp, { recursive: true });
  }
});
