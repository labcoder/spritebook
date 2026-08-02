/**
 * Do the rendered feet land on the recorded pivot?
 *
 * `pivotFor` returns row `cellPx.h - paddingPx` for a `feet-baseline` pivot,
 * and the quickstart promises that an AnimatedSprite2D at its default settings
 * therefore puts the node origin on the character's feet. The framing
 * measurement found the silhouette reaching the LAST row of the cell no matter
 * how big the cell was — which, if the pivot really is `h - padding`, means the
 * two disagree by a fixed number of pixels and every exported sprite's origin
 * floats above the ground.
 *
 * This prints the raw rows rather than deltas so the claim is checkable: cell
 * height, pivot row, and the first/last alpha row of each frame. It bakes the
 * bind-pose idle stub (no clips, no retarget) so nothing but the camera solver
 * and the pivot are in the picture.
 *
 * WHAT IT FOUND, and the caveat (D-033): the four bind-pose cases land at
 * exactly +0 — the camera solver and `pivotFor` agree. The clip case reads +3,
 * but `tools/proofs/meshfloor.ts` shows that clip's skinned mesh sitting at
 * +0.37 px, ABOVE the floor. So the +3 is not a sink, and what it IS remains
 * unexplained. Treat this script as evidence about the bind pose only until
 * that is resolved.
 *
 * Run: DENO_WEBGPU_BACKEND=vulkan deno run --allow-all tools/proofs/pivotcheck.ts
 */
import { decode as decodePng } from 'npm:fast-png@6.2.0';
import { runCli } from '../../packages/cli/mod.ts';
import { BakeManifestSchema, parseWith } from '../../packages/schema/mod.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const IMAGE = `${REPO}spikes/trellis2/refs/bulma-front.png`;
const BODY = `${REPO}packages/rig/bodies/ubc-male`;

function io() {
  const out: string[] = [];
  return { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), out };
}
async function cli(args: string[], label: string): Promise<void> {
  const o = io();
  const code = await runCli(args, o);
  if (code !== 0) throw new Error(`${label} exited ${code}:\n${o.out.slice(-10).join('\n')}`);
}

/** first and last rows of the cell that carry any alpha */
function rows(rgba: Uint8Array, pageW: number, r: { x: number; y: number; w: number; h: number }) {
  let first = -1;
  let last = -1;
  for (let y = 0; y < r.h; y++) {
    let any = false;
    for (let x = 0; x < r.w; x++) {
      if (rgba[((r.y + y) * pageW + (r.x + x)) * 4 + 3]! !== 0) {
        any = true;
        break;
      }
    }
    if (any) {
      if (first < 0) first = y;
      last = y;
    }
  }
  return { first, last };
}

async function measure(cell: string, padding: string, ppm: string, useClips: boolean) {
  const tmp = await Deno.makeTempDir();
  const ws = `${tmp}/pc`;
  try {
    await cli(
      [
        'gen',
        '--workspace',
        ws,
        '--character',
        'pivotcheck',
        '--image',
        IMAGE,
        '--model',
        'fixture-gen',
      ],
      'gen',
    );
    await cli(['pick', '--workspace', ws, '--result', 'r1'], 'pick');
    await cli(
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
      'fit',
    );
    if (useClips) await cli(['anim', '--enable', 'idle-loop:4', '--workspace', ws], 'anim');
    await cli(
      [
        'bake',
        '--workspace',
        ws,
        '--cell',
        cell,
        '--ppm',
        ppm,
        '--padding',
        padding,
        '--directions',
        '2',
      ],
      'bake',
    );
    const character = JSON.parse(await Deno.readTextFile(`${ws}/character.json`));
    const dir = `${ws}/bakes/bake-${character.lastBakeId}`;
    const bake = parseWith(
      BakeManifestSchema,
      JSON.parse(await Deno.readTextFile(`${dir}/manifest.json`)),
      'BakeManifest',
    );
    const lit = bake.atlases.find((a) => a.pass === 'lit')!;
    const png = decodePng(await Deno.readFile(`${dir}/${lit.png}`));
    const data = new Uint8Array(png.data as unknown as ArrayLike<number>);
    const f = bake.frames[0]!;
    const { first, last } = rows(data, png.width, f.atlas);
    const cellH = f.atlas.h;
    console.log(
      `  cell ${cell.padEnd(8)} padding ${padding.padStart(2)} ${useClips ? 'clip ' : 'stub '}` +
        `-> h ${String(cellH).padStart(3)} · pivot row ${String(f.pivotPx.y).padStart(3)} · ` +
        `alpha rows ${String(first).padStart(3)}..${String(last).padStart(3)} · ` +
        `feet are ${last - f.pivotPx.y >= 0 ? '+' : ''}${last - f.pivotPx.y} from the pivot`,
    );
    return { cellH, pivotY: f.pivotPx.y, first, last, padding: Number(padding) };
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

console.log('# Do the rendered feet land on the recorded pivot?');
console.log('  (a `feet-baseline` pivot is row h - paddingPx; the feet should sit ON it)');
const results = [];
for (const [cell, padding] of [['64', '6'], ['128x128', '6'], ['128x128', '16'], ['64', '2']]) {
  results.push(await measure(cell!, padding!, '32', false));
}
console.log('\n# the same, with a retargeted clip rather than the bind-pose stub');
results.push(await measure('128x128', '6', '32', true));

console.log('\n## verdict');
const offsets = results.map((r) => r.last - r.pivotY);
const bottomGap = results.map((r) => r.cellH - 1 - r.last);
console.log(`  feet-minus-pivot across the runs: ${offsets.join(', ')}`);
console.log(`  rows left below the feet:         ${bottomGap.join(', ')}`);
if (offsets.every((o) => o === 0)) {
  console.log('  the feet sit exactly on the pivot — the promise holds.');
} else if (results.every((r) => r.cellH - 1 - r.last === 0)) {
  console.log(
    '  the silhouette reaches the LAST row of the cell in every configuration, while the\n' +
      '  pivot is `h - padding`. The camera solver grounds the character on the cell floor\n' +
      '  rather than on the pivot row, so the recorded pivot floats `padding - 1` px above\n' +
      '  the feet — and no cell size fixes it, which is why the oversized bake still flagged.',
  );
} else {
  console.log('  mixed: read the rows above.');
}
