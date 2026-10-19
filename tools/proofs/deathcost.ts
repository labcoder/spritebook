/**
 * The D-035 product question, settled with bytes: should the shipped default be
 * sized for a clip set that contains a lying-down death?
 *
 * D-035 adopted `cellPx 112 / paddingPx 16` because ONE clip — death01, whose
 * footprint is metres deep — drives the whole ground-band budget. Without it the
 * band tops out at 8 px and `padding 9 / cell 96` would do, at a third less
 * atlas. That is a real saving and the entry left the call open.
 *
 * Four configurations, because two would not separate the causes:
 *
 *   1. 112/16 WITH death      the shipped default — the baseline
 *   2. 112/16 without death   isolates what the CLIP costs in bytes
 *   3.  96/9  without death   the proposed cheaper default
 *   4.  96/9  WITH death      the TRAP CASE, and the one that decides it: a
 *                             user who takes the cheap default and later adds a
 *                             death animation. If that clips, the cheap default
 *                             is a trap and 112/16 is the honest ship.
 *
 * Bytes are reported per character. Each character bakes into its own directory
 * with its own atlas pages, so per-character size does not depend on roster
 * size — a handful of characters measures the same thing a hundred would, and
 * this run costs minutes instead of hours.
 *
 * Run: DENO_WEBGPU_BACKEND=vulkan deno run --allow-all tools/proofs/deathcost.ts [--n 3]
 */
import { runCli } from '../../packages/cli/mod.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const IMAGE = `${REPO}tests/fixtures/bulma-front.png`;
const BODY = `${REPO}packages/rig/bodies/ubc-male`;

const WITH_DEATH = 'idle-loop:8,walk-loop:8,jog-fwd-loop:8,sprint-loop:6,punch-jab:6,death01:10';
const NO_DEATH = 'idle-loop:8,walk-loop:8,jog-fwd-loop:8,sprint-loop:6,punch-jab:6';

const arg = (n: string, d: string) => {
  const i = Deno.args.indexOf(`--${n}`);
  return i >= 0 && Deno.args[i + 1] !== undefined ? Deno.args[i + 1]! : d;
};
const N = Number(arg('n', '3'));

const lines: string[] = [];
const say = (s: string) => {
  console.log(s);
  lines.push(s);
};
function io() {
  const out: string[] = [];
  return { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), out };
}
async function cli(args: string[], label: string): Promise<string[]> {
  const o = io();
  if (await runCli(args, o) !== 0) throw new Error(`${label}: ${o.out.slice(-10).join('\n')}`);
  return o.out;
}

/** total bytes under a directory, recursively */
async function bytesOf(dir: string): Promise<number> {
  let total = 0;
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) total += await bytesOf(p);
    else if (e.isFile) total += (await Deno.stat(p)).size;
  }
  return total;
}

interface Result {
  label: string;
  cell: string;
  pad: string;
  clips: string;
  frames: number;
  bakeBytes: number;
  flaggedFrames: number;
  edges: string;
}

const id = (i: number) => `dc-${String(i).padStart(2, '0')}`;

async function measure(
  label: string,
  cell: string,
  pad: string,
  clips: string,
): Promise<Result> {
  const root = await Deno.makeTempDir();
  try {
    let bakeBytes = 0;
    let frames = 0;
    let flaggedFrames = 0;
    let edges = '';
    for (let i = 0; i < N; i++) {
      const ws = `${root}/${id(i)}`;
      await cli([
        'gen',
        '--workspace',
        ws,
        '--character',
        id(i),
        '--image',
        IMAGE,
        '--model',
        'fixture-gen',
        '--seed',
        String(i),
      ], `gen ${id(i)}`);
      await cli(['pick', '--workspace', ws, '--result', 'r1'], `pick ${id(i)}`);
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
      ], `fit ${id(i)}`);
      await cli(['anim', '--enable', clips, '--workspace', ws], `anim ${id(i)}`);
      const out = await cli(
        ['bake', '--workspace', ws, '--cell', cell, '--padding', pad],
        `bake ${id(i)}`,
      );
      const flag = out.find((l) => l.includes('silhouette-clipped'));
      const m = flag?.match(/on (\d+) frames? \(([^)]*)\)/);
      if (m) {
        flaggedFrames += Number(m[1]);
        edges = m[2]!;
      }
      const manifest = JSON.parse(await Deno.readTextFile(`${ws}/character.json`));
      const bakeDir = `${ws}/bakes/bake-${manifest.lastBakeId}`;
      bakeBytes += await bytesOf(bakeDir);
      frames = JSON.parse(await Deno.readTextFile(`${bakeDir}/manifest.json`)).frames.length;
    }
    return {
      label,
      cell,
      pad,
      clips: clips === WITH_DEATH ? 'with death' : 'no death',
      frames,
      bakeBytes: Math.round(bakeBytes / N),
      flaggedFrames: Math.round(flaggedFrames / N),
      edges,
    };
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

const mb = (b: number) => (b / 1024 / 1024).toFixed(2);

say(`# Does the shipped default have to carry the death clip? (${N} characters per config)`);
const results: Result[] = [];
for (
  const [label, cell, pad, clips] of [
    ['1. shipped        ', '112', '16', WITH_DEATH],
    ['2. shipped, no death', '112', '16', NO_DEATH],
    ['3. cheap default  ', '96', '9', NO_DEATH],
    ['4. cheap + a death', '96', '9', WITH_DEATH],
  ] as const
) {
  results.push(await measure(label, cell, pad, clips));
}

say('');
say('  config                cell/pad   clips        frames   MB/char   flagged frames');
for (const r of results) {
  say(
    `  ${r.label.padEnd(21)} ${(r.cell + '/' + r.pad).padEnd(10)} ${r.clips.padEnd(12)} ` +
      `${String(r.frames).padStart(6)}   ${mb(r.bakeBytes).padStart(7)}   ` +
      `${String(r.flaggedFrames).padStart(6)}${r.edges ? ` (${r.edges})` : ''}`,
  );
}

const [shipped, shippedNo, cheap, trap] = results as [Result, Result, Result, Result];
say('');
say('## what the numbers say');
say(
  `  the DEATH CLIP itself costs ${mb(shipped.bakeBytes - shippedNo.bakeBytes)} MB/char ` +
    `(${shipped.frames - shippedNo.frames} frames) at the shipped cell`,
);
say(
  `  the CELL/PADDING costs      ${mb(shippedNo.bakeBytes - cheap.bakeBytes)} MB/char ` +
    `(112/16 vs 96/9, same clips) = ` +
    `${(100 * (shippedNo.bakeBytes / cheap.bakeBytes - 1)).toFixed(0)}% more`,
);
say(
  `  a roster of 100 differs by  ${
    mb((shipped.bakeBytes - cheap.bakeBytes) * 100)
  } MB between the shipped default and the cheap one`,
);
say('');
if (trap.flaggedFrames > 0) {
  say(
    `  THE TRAP CASE DECIDES IT: the cheap default with a death added flags\n` +
      `  ${trap.flaggedFrames} frames/char (${trap.edges}). A user who takes 96/9 and later\n` +
      `  adds a death animation gets clipped sprites and no warning until they look.`,
  );
} else {
  say(
    `  The trap case does NOT clip: 96/9 with a death added flags nothing, so the\n` +
      `  cheap default is safe and the shipped one is over-provisioned.`,
  );
}

await Deno.writeTextFile(
  `${REPO}docs/internal/proofs/deathcost.md`,
  '# Does the default have to carry the death clip? (D-035 follow-up)\n\nCaptured by ' +
    '`tools/proofs/deathcost.ts`; regenerate rather than hand-editing.\n\n```\n' +
    lines.join('\n') + '\n```\n',
);
console.log('\nrecorded to docs/internal/proofs/deathcost.md');
