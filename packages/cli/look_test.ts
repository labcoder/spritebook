import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * `look` (P4-T2): the look as a DECISION, separated from the bake that runs
 * it. --list serves the real preset rosters (a GUI renders cards from these,
 * so their shape is a contract); the record path merges like the bake does,
 * refuses illegal combinations BEFORE writing, states the cost from the real
 * bake artifact, and journals one patch so undo takes it back.
 */
import { assert, assertEquals } from '@std/assert';
import { createWorkspace } from '@spritebook/core';
import { runCli } from './dist/mod.js';

function io() {
  const out: string[] = [];
  return { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), out };
}

test('capture camera and lighting flags record together and reject invalid lighting before writing', async () => {
  const { dir, tmp } = await ws();
  try {
    const args = [
      'look',
      '--workspace',
      dir,
      '--style',
      'clean',
      '--projection',
      'perspective',
      '--yaw',
      '90',
      '--fov',
      '40',
      '--ambient',
      '0.6',
      '--light-yaw',
      '0',
      '--light-elevation',
      '90',
      '--supersample',
      '1',
      '--json',
    ];
    const output = io();
    assertEquals(await runCli(args, output), 0);
    const { look } = JSON.parse(output.out.at(-1)!);
    assertEquals(look.cameraOverrides, { orthographic: false, yawOffsetDeg: 90, fovDeg: 40 });
    assertEquals(look.overrides.temporal.superSample, 1);
    assertEquals(look.overrides.lighting.ambient, .6);
    assert(Math.abs(look.overrides.lighting.direction[1] - 1) < 1e-6);
    const before = await fs.readFile(`${dir}/character.json`, 'utf8');
    assertEquals(await runCli(['look', '--workspace', dir, '--ambient', '2', '--json'], io()), 1);
    assertEquals(await fs.readFile(`${dir}/character.json`, 'utf8'), before);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

async function ws(): Promise<{ dir: string; tmp: string }> {
  const tmp = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  const dir = `${tmp}/sprout`;
  await createWorkspace({
    workspace: dir,
    characterId: 'sprout',
    displayName: 'sprout',
    source: { kind: 'image', originalFilename: 'x.png', sha256: 'a'.repeat(64) },
  });
  return { dir, tmp };
}

test('--list serves the real rosters with the knobs a picker needs', async () => {
  const o = io();
  assertEquals(await runCli(['look', '--list', '--json'], o), 0);
  const doc = JSON.parse(o.out.at(-1)!);
  const cameras = doc.cameras as { id: string; elevationDeg: number; directions: number }[];
  const styles = doc.styles as { id: string; maxColors?: number; outlineWidthPx?: number }[];
  assertEquals(doc.defaults, { camera: 'standard-30', style: 'pixel' });
  assert(cameras.some((c) => c.id === 'standard-30' && c.elevationDeg === 30));
  assert(cameras.every((c) => typeof c.directions === 'number'), 'every camera states its dirs');
  const pixel = styles.find((s) => s.id === 'pixel')!;
  assertEquals(pixel.maxColors, 16, 'the shipped 16 reaches the picker');
  assertEquals(pixel.outlineWidthPx, 0.5, 'and the outline the A-wave picked');
  const clean = styles.find((s) => s.id === 'clean')!;
  assertEquals(clean.maxColors, undefined, 'a style with no palette says so by absence');
  assertEquals(clean.outlineWidthPx, undefined);
});

test('recording merges like the bake, and one undo takes it back', async () => {
  const { dir, tmp } = await ws();
  try {
    const o = io();
    assertEquals(await runCli(['look', '--workspace', dir, '--style', 'pixel', '--json'], o), 0);
    assertEquals(JSON.parse(o.out.at(-1)!).look, {
      cameraPresetId: 'standard-30',
      stylePresetId: 'pixel',
    });

    // a camera flag alone keeps the recorded style, and vice versa
    const o2 = io();
    await runCli(['look', '--workspace', dir, '--elevation', '15', '--json'], o2);
    const look2 = JSON.parse(o2.out.at(-1)!).look;
    assertEquals(look2.stylePresetId, 'pixel', 'the stored style survives a camera change');
    assertEquals(look2.cameraOverrides, { elevationDeg: 15 });

    // nothing baked yet: the honest cost is zero
    assertEquals(JSON.parse(o2.out.at(-1)!).staleFrames, 0);

    assertEquals(await runCli(['undo', '--manifest', `${dir}/character.json`], io()), 0);
    const manifest = JSON.parse(await fs.readFile(`${dir}/character.json`, 'utf8'));
    assertEquals(manifest.look.cameraOverrides, undefined, 'the elevation decision is undone');
    assertEquals(manifest.look.stylePresetId, 'pixel', 'and the one before it survives');
  } finally {
    await fs.rm(tmp, { recursive: true });
  }
});

test('an illegal look is refused BEFORE it reaches the manifest', async () => {
  const { dir, tmp } = await ws();
  try {
    // 5 is not a legal direction count (2|4|8|16)
    const o = io();
    assertEquals(await runCli(['look', '--workspace', dir, '--directions', '5'], o), 1);
    assert(o.out.join('\n').includes('2, 4, 8, or 16'), 'the message names the choices');

    // --colors on a style that has no palette
    const o2 = io();
    assertEquals(
      await runCli(['look', '--workspace', dir, '--style', 'clean', '--colors', '16'], o2),
      1,
    );
    assert(o2.out.join('\n').includes('does not quantize'), 'and names why');

    const manifest = JSON.parse(await fs.readFile(`${dir}/character.json`, 'utf8'));
    assertEquals(manifest.look, undefined, 'nothing illegal was recorded');
  } finally {
    await fs.rm(tmp, { recursive: true });
  }
});

test('--outline sets the width, and refuses a style that draws none', async () => {
  const { dir, tmp } = await ws();
  try {
    const o = io();
    assertEquals(
      await runCli(
        ['look', '--workspace', dir, '--style', 'pixel', '--outline', '1.5', '--json'],
        o,
      ),
      0,
    );
    assertEquals(JSON.parse(o.out.at(-1)!).look.overrides.outline.widthPx, 1.5);

    const o2 = io();
    assertEquals(
      await runCli(['look', '--workspace', dir, '--style', 'clean', '--outline', '2'], o2),
      1,
    );
    assert(o2.out.join('\n').includes('draws no outline'));
  } finally {
    await fs.rm(tmp, { recursive: true });
  }
});
