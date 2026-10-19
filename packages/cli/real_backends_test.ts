import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The real-backend acceptance lane (W4e): gen -> rig track B -> preview ->
 * bake against the ACTUAL installed backends on this machine's GPU, asserting
 * PIXELS, not exit codes. Exists because UX pass 2 found four P1s under a
 * fully green suite — the fixtures made retexture's frame restore, UniRig's
 * joint naming, and the collapsed-pose bake invisible. This lane is the
 * anti-regression for that whole class: if the sheet is a smear, it fails.
 *
 * Gated twice, honestly: skipped without SPRITEBOOK_REAL_BACKENDS=1 (it
 * costs minutes of GPU). An explicitly requested lane fails on missing prerequisites.
 * Run it with `npm run test:real`.
 */
import { assert, assertEquals } from '@std/assert';
import { decode as decodePng } from 'fast-png';
import { NodeIO } from '@gltf-transform/core';
import { runCli } from './dist/mod.js';

const WANTED = process.env['SPRITEBOOK_REAL_BACKENDS'] === '1';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const IMAGE = `${REPO}tests/fixtures/bulma-front.png`;

function io() {
  const out: string[] = [];
  return { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), out };
}
async function cli(args: string[]): Promise<{ code: number; out: string[] }> {
  const o = io();
  const code = await runCli(args, o);
  return { code, out: o.out };
}

test('real backends: gen -> rig B -> preview -> bake puts a character on the sheet', { skip: !WANTED }, async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'sb-real-'));
    const ws = `${root}/w`;
    try {
      // 1. REAL generation - one candidate, the reference image, a fixed
      // seed, and a DECLARED height: without it the canonical keeps
      // TRELLIS's ~1-unit box scale and a 32 px/m bake renders a ~30 px
      // smear - the first thing this lane ever caught. Declaring height is
      // the documented contract (D-012), so the lane generates the way a
      // properly-instructed user does.
      const gen = await cli([
        'gen',
        '--workspace',
        ws,
        '--character',
        'real',
        '--image',
        IMAGE,
        '--model',
        'trellis2-4b',
        '--seed',
        '7',
        '--height',
        '1.7',
      ]);
      assertEquals(gen.code, 0, `gen: ${gen.out.slice(-4).join('\n')}`);
      const pick = await cli(['pick', '--workspace', ws, '--result', 'r1']);
      assertEquals(pick.code, 0, `pick: ${pick.out.slice(-4).join('\n')}`);

      // 2. REAL track-B rig - the default track, the one the fixtures never see
      const rig = await cli([
        'rig',
        '--workspace',
        ws,
        '--model',
        `${ws}/canonical/model.glb`,
        '--out',
        `${ws}/rig`,
      ]);
      assertEquals(rig.code, 0, `rig B: ${rig.out.slice(-4).join('\n')}`);

      // the rescue's claim on a REAL prediction: every retarget-critical
      // joint is named (pelvis above all - the borderline one in the field)
      const rigged = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(`${ws}/rig/rigged.glb`)));
      const names = new Set(
        rigged.getRoot().listNodes().filter((n) => !n.getMesh()).map((n) => n.getName()),
      );
      for (const j of ['pelvis', 'hand_l', 'hand_r', 'thigh_l', 'thigh_r', 'foot_l', 'foot_r']) {
        assert(names.has(j), `track-B skeleton is missing "${j}" (has: ${[...names].join(' ')})`);
      }

      // 3. the preview retargets onto that rig (D-040 aliases + rescue)
      const preview = await cli(['anim', '--preview', 'idle-loop', '--workspace', ws]);
      assertEquals(preview.code, 0, `preview: ${preview.out.slice(-4).join('\n')}`);

      // 4. enable + REAL bake (bake takes the camera/style directly)
      for (
        const args of [
          ['anim', '--enable', 'idle-loop:6', '--workspace', ws],
          ['bake', '--workspace', ws, '--camera', 'standard-30', '--style', 'pixel'],
        ]
      ) {
        const r = await cli(args);
        assertEquals(r.code, 0, `${args[0]}: ${r.out.slice(-4).join('\n')}`);
      }

      // 5. PIXELS. The character must actually be on the sheet: no
      // subject-degenerate flag, and the first frame's atlas cell holds alpha
      // coverage in a sane band - the UX-pass smear measured ~1.6%, a healthy
      // character 10-30%. Exit codes said "done" both times; only this tells
      // them apart.
      const manifest = JSON.parse(
        await fs.readFile(`${ws}/character.json`, 'utf8'),
      ) as { lastBakeId?: string };
      assert(manifest.lastBakeId, 'the bake recorded itself');
      const bakeDir = `${ws}/bakes/bake-${manifest.lastBakeId}`;
      const bakeManifest = JSON.parse(await fs.readFile(`${bakeDir}/manifest.json`, 'utf8')) as {
        flags: { code: string }[];
        frames: {
          clipId: string;
          direction: number;
          atlas: { pageIndex: number; x: number; y: number; w: number; h: number };
        }[];
      };
      assertEquals(
        bakeManifest.flags.filter((f) => f.code === 'subject-degenerate'),
        [],
        'the sheet carries a subject',
      );
      const cell = bakeManifest.frames.find((f) => f.clipId === 'idle-loop' && f.direction === 0);
      assert(cell, 'the manifest places idle-loop d0');
      const atlas = decodePng(
        new Uint8Array(await fs.readFile(`${bakeDir}/atlas_lit_${cell!.atlas.pageIndex}.png`)),
      );
      const data = atlas.data as Uint8Array;
      let on = 0;
      for (let y = 0; y < cell!.atlas.h; y++) {
        for (let x = 0; x < cell!.atlas.w; x++) {
          const i = ((cell!.atlas.y + y) * atlas.width + cell!.atlas.x + x) * 4 + 3;
          if (data[i] !== 0) on++;
        }
      }
      const cov = on / (cell!.atlas.w * cell!.atlas.h);
      // the band is MEASURED, not guessed: the unscaled smear covered 1.6-2.8%
      // and a real 1.7 m slim character at 32 px/m covers 4.3% on this very
      // pipeline (2026-08-08). 3.5% splits those populations; 90% rejects an
      // alpha flood.
      assert(
        cov > 0.035 && cov < 0.9,
        `idle-loop d0 f0 alpha coverage ${(cov * 100).toFixed(1)}% is outside the sane band ` +
          `(3.5-90%) - a smear or a flood, not a character`,
      );
      console.log(`real-backend lane: coverage ${(cov * 100).toFixed(1)}%, all stages green`);
    } finally {
      await fs.rm(root, { recursive: true }).catch(() => {});
    }
});
