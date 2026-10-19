/**
 * The feet-baseline pivot question, with numbers for all three options.
 *
 * D-034 established the mechanism: the pivot pins world Y=0 at ONE point (the
 * bounds centre), so at elevation the ground plane is a BAND and a contact
 * point `d` metres nearer the camera lands `d·sin(el)·ppm` px below the pivot
 * row. Rows available below the pivot are `paddingPx - 1`, always, whatever the
 * cell height. This decides what to do about that.
 *
 * ONE measurement answers all three, which is why it is one script: bake the
 * clip set with a padding so large that nothing can be cut, and record each
 * frame's `below` — the distance from the pivot row to its lowest opaque row.
 * That single distribution is:
 *
 *   (a) how much padding a bounds-centre anchor needs   = max(below) + 1
 *   (b) how far a near-edge anchor would MOVE the pivot = the spread of below,
 *       because anchoring at the near edge means shifting the pivot down by
 *       exactly `below` on that frame — so the variation in `below` IS the
 *       frame-to-frame jitter of what the pivot means in world space
 *   (c) which frames are GENUINELY cut at a given padding (below > padding-1)
 *       versus merely touching the last row (below == padding-1)
 *
 * Run: DENO_WEBGPU_BACKEND=vulkan deno run --allow-all tools/proofs/pivotoptions.ts
 */
import { decode as decodePng } from 'npm:fast-png@6.2.0';
import { runCli } from '../../packages/cli/mod.ts';
import { BakeManifestSchema, parseWith } from '../../packages/schema/mod.ts';
import { STANDARD_30 } from '../../packages/core/presets.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const IMAGE = `${REPO}tests/fixtures/bulma-front.png`;
const BODY = `${REPO}packages/rig/bodies/ubc-male`;
const CLIPS = 'idle-loop:8,walk-loop:8,jog-fwd-loop:8,sprint-loop:6,punch-jab:6,death01:10';
/** big enough that the band cannot be cut: 96 rows below the pivot */
const PROBE_CELL = '256x256';
const PROBE_PAD = 97;
const PPM = 32;

const lines: string[] = [];
const say = (s: string) => {
  console.log(s);
  lines.push(s);
};
function io() {
  const out: string[] = [];
  return { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), out };
}
async function cli(args: string[], label: string) {
  const o = io();
  if (await runCli(args, o) !== 0) throw new Error(`${label}: ${o.out.slice(-10).join('\n')}`);
}

interface Row {
  clipId: string;
  direction: number;
  frame: number;
  below: number;
}

const tmp = await Deno.makeTempDir();
const ws = `${tmp}/c`;
try {
  await cli([
    'gen',
    '--workspace',
    ws,
    '--character',
    'pivotopts',
    '--image',
    IMAGE,
    '--model',
    'fixture-gen',
  ], 'gen');
  await cli(['pick', '--workspace', ws, '--result', 'r1'], 'pick');
  await cli([
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
  ], 'fit');
  await cli(['anim', '--enable', CLIPS, '--workspace', ws], 'anim');
  await cli([
    'bake',
    '--workspace',
    ws,
    '--cell',
    PROBE_CELL,
    '--ppm',
    String(PPM),
    '--padding',
    String(PROBE_PAD),
  ], 'probe bake');

  const character = JSON.parse(await Deno.readTextFile(`${ws}/character.json`));
  const bakeDir = `${ws}/bakes/bake-${character.lastBakeId}`;
  const bake = parseWith(
    BakeManifestSchema,
    JSON.parse(await Deno.readTextFile(`${bakeDir}/manifest.json`)),
    'BakeManifest',
  );
  say('# The feet-baseline pivot question, measured');
  say(
    `  probe: ${PROBE_CELL} cell, padding ${PROBE_PAD} (${PROBE_PAD - 1} rows below the pivot), ` +
      `ppm ${PPM}, ${bake.frames.length} frames`,
  );
  say(
    `  probe flags: ${
      bake.flags.map((f) => f.code).join(', ') || 'none — nothing was cut, so ' +
        'every `below` below is the TRUE extent'
    }`,
  );

  const pages = new Map<number, { data: Uint8Array; width: number }>();
  for (const page of bake.atlases.filter((a) => a.pass === 'lit')) {
    const png = decodePng(await Deno.readFile(`${bakeDir}/${page.png}`));
    pages.set(page.pageIndex, {
      data: new Uint8Array(png.data as unknown as ArrayLike<number>),
      width: png.width,
    });
  }
  const rows: Row[] = [];
  for (const f of bake.frames) {
    const page = pages.get(f.atlas.pageIndex)!;
    let last = -1;
    for (let y = 0; y < f.atlas.h; y++) {
      for (let x = 0; x < f.atlas.w; x++) {
        if (page.data[((f.atlas.y + y) * page.width + (f.atlas.x + x)) * 4 + 3]! !== 0) {
          last = y;
          break;
        }
      }
    }
    if (last < 0) continue;
    rows.push({
      clipId: f.clipId,
      direction: f.direction,
      frame: f.frame,
      below: last - f.pivotPx.y,
    });
  }

  const belows = rows.map((r) => r.below);
  const max = Math.max(...belows);
  const min = Math.min(...belows);
  const mean = belows.reduce((a, b) => a + b, 0) / belows.length;

  // ---------------------------------------------------------------- per clip
  say('\n## the ground band, per clip (px below the pivot row)');
  say('  clip              min   max  spread');
  const byClip = new Map<string, number[]>();
  for (const r of rows) byClip.set(r.clipId, [...(byClip.get(r.clipId) ?? []), r.below]);
  for (const [clipId, list] of [...byClip].sort()) {
    const lo = Math.min(...list), hi = Math.max(...list);
    say(
      `  ${clipId.padEnd(15)} ${String(lo).padStart(4)} ${String(hi).padStart(5)} ` +
        `${String(hi - lo).padStart(6)}`,
    );
  }
  say(
    `  ${'ALL'.padEnd(15)} ${String(min).padStart(4)} ${String(max).padStart(5)} ` +
      `${String(max - min).padStart(6)}   (mean ${mean.toFixed(1)})`,
  );

  // ------------------------------------------------------------- option (a)
  const cell = STANDARD_30.cellPx;
  const needPad = max + 1;
  const areaAt = (pad: number) => (cell.w - 2 * pad) * (cell.h - 2 * pad);
  const now = areaAt(STANDARD_30.paddingPx);
  const then = areaAt(needPad);
  say('\n## (a) keep the bounds-centre anchor, raise paddingPx until nothing clips');
  say(
    `  padding needed: ${needPad} px (max band ${max} + 1), against today's ${STANDARD_30.paddingPx}`,
  );
  say(
    `  usable area in a ${cell.w}x${cell.h} cell: ${cell.w - 2 * STANDARD_30.paddingPx}x` +
      `${cell.h - 2 * STANDARD_30.paddingPx} = ${now} px -> ` +
      `${cell.w - 2 * needPad}x${cell.h - 2 * needPad} = ${then} px ` +
      `(${((1 - then / now) * 100).toFixed(0)}% of the drawable cell given up)`,
  );
  if (cell.w - 2 * needPad <= 0) {
    say('  which is NEGATIVE — the padding needed exceeds the cell. (a) cannot work at this cell.');
  } else {
    const char = 1.7 * PPM;
    say(
      `  a ${1.7} m character is ${char.toFixed(0)} px tall and would have ` +
        `${cell.h - 2 * needPad} px of drawable height: ` +
        `${char <= cell.h - 2 * needPad ? 'it still fits' : 'IT NO LONGER FITS'}`,
    );
  }

  // ------------------------------------------------------------- option (b)
  say('\n## (b) anchor at the near edge of the per-frame footprint');
  say(
    '  Anchoring there shifts the pivot down by exactly `below` on that frame, so the',
  );
  say('  variation in `below` IS how far the pivot moves in world terms frame to frame.');
  const perDir = new Map<number, number[]>();
  for (const r of rows) perDir.set(r.direction, [...(perDir.get(r.direction) ?? []), r.below]);
  const dirSpreads = [...perDir.values()].map((l) => Math.max(...l) - Math.min(...l));
  say(`  jitter WITHIN a direction, worst: ${Math.max(...dirSpreads)} px`);
  say(`  jitter across the whole roster:   ${max - min} px`);
  // the same frame index across directions — what a turning character sees
  const byDirFrame = new Map<string, number[]>();
  for (const r of rows) {
    const k = `${r.clipId}#${r.frame}`;
    byDirFrame.set(k, [...(byDirFrame.get(k) ?? []), r.below]);
  }
  const turnSpreads = [...byDirFrame.values()].map((l) => Math.max(...l) - Math.min(...l));
  say(
    `  jitter for ONE frame across the 8 directions, worst: ${Math.max(...turnSpreads)} px ` +
      `(a character turning on the spot)`,
  );
  say(
    `  => the engine contract ("place the node at a tile's floor position and the character\n` +
      `     stands on it") would break by up to ${max - min} px = ` +
      `${((max - min) / PPM * 100).toFixed(0)} cm of world position, per frame.`,
  );

  // ------------------------------------------------------------- option (c)
  say('\n## (c) keep the anchor; fire the bottom check only on GENUINE clipping');
  say('  padding  rows below  touching   genuinely cut   frames flagged today');
  for (const pad of [6, 8, 10, 12, 16, 20, 24, needPad]) {
    const avail = pad - 1;
    const touching = rows.filter((r) => r.below === avail).length;
    const cut = rows.filter((r) => r.below > avail).length;
    say(
      `  ${String(pad).padStart(7)} ${String(avail).padStart(11)} ${
        String(touching).padStart(9)
      } ` +
        `${String(cut).padStart(15)} ${String(touching + cut).padStart(21)}`,
    );
  }
  say(
    `\n  At today's padding ${STANDARD_30.paddingPx}, ` +
      `${
        rows.filter((r) => r.below > STANDARD_30.paddingPx - 1).length
      } of ${rows.length} frames ` +
      `LOSE pixels and ${
        rows.filter((r) => r.below === STANDARD_30.paddingPx - 1).length
      } merely ` +
      `touch the last row.`,
  );
} finally {
  await Deno.writeTextFile(
    `${REPO}docs/internal/proofs/pivotoptions.md`,
    '# The feet-baseline pivot question (P4-T3 follow-up)\n\nCaptured by ' +
      '`tools/proofs/pivotoptions.ts`; regenerate rather than hand-editing.\n\n```\n' +
      lines.join('\n') + '\n```\n',
  );
  console.log('\nrecorded to docs/internal/proofs/pivotoptions.md');
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
}
