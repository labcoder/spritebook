/**
 * How far does the SKINNED MESH actually go below the ground plane?
 *
 * Ground truth for the `silhouette-clipped` flag's `bottom` edge, and the tool
 * that should have been written first. `tools/proofs/framing.ts` measures the
 * silhouette in PIXELS out of a baked atlas, which is the right instrument for
 * the left/right edges (they are a cell-size question) and the wrong one for
 * the bottom: its `below` column reads 4–5 px for every clip, including clips
 * whose geometry provably never leaves the floor, so something between the
 * mesh and that column is not what it looks like. Do not trust it for `bottom`.
 *
 * This measures the thing itself. It retargets each clip onto the target
 * skeleton exactly as the bake does, samples the same frame grid, runs the
 * renderer's own four-influence skinning (`@spritebook/rig`'s `skinAll`, the
 * CPU mirror of the vertex shader), and reports the minimum world Y over every
 * vertex of every frame. Negative means geometry under the ground plane.
 *
 * It also prints the retargeter's own `footContactMaxErrM`, so the two
 * independent numbers sit side by side: what the correction pass believes it
 * achieved, and where the mesh actually ended up.
 *
 * Run:
 *   deno run --allow-all tools/proofs/meshfloor.ts [--body <glb>] [--clips a,b,c]
 *
 * With no `--body` it builds a Track A fitted character the way the roster
 * proof does, which is the configuration the 100-character run flagged.
 */
import { NodeIO } from 'npm:@gltf-transform/core@4.4.1';
import { runCli } from '../../packages/cli/mod.ts';
import { loadClip, loadSkeletonRestFromFile, UAL_HUMANOID } from '../../packages/anim/profile.ts';
import { retargetClip } from '../../packages/anim/retarget.ts';
import { sampleClip } from '../../packages/anim/sample.ts';
import { loadRiggedAsset, skinAll, skinMatrices } from '../../packages/rig/skin.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PACK = `${REPO}packages/anim/packs/ual`;
const arg = (n: string, d = '') => {
  const i = Deno.args.indexOf(`--${n}`);
  return i >= 0 && Deno.args[i + 1] !== undefined ? Deno.args[i + 1]! : d;
};
const CLIPS = arg('clips', 'idle-loop,walk-loop,jog-fwd-loop,sprint-loop,punch-jab,death01')
  .split(',');
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
  if (await runCli(args, o) !== 0) throw new Error(`${label}: ${o.out.slice(-8).join('\n')}`);
}

/** column-major 4x4 multiply, into `o` */
function mul(a: Float32Array, b: Float32Array, o: Float32Array): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  }
}

/** Build a Track A character the way the roster proof does. */
async function fittedBody(into: string): Promise<string> {
  const ws = `${into}/c`;
  await cli([
    'gen',
    '--workspace',
    ws,
    '--character',
    'meshfloor',
    '--image',
    `${REPO}spikes/trellis2/refs/bulma-front.png`,
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
    `${REPO}packages/rig/bodies/ubc-male`,
    '--model',
    `${ws}/canonical/model.glb`,
    '--out',
    `${ws}/rig`,
  ], 'fit');
  return `${ws}/canonical/model.glb`;
}

const tmp = await Deno.makeTempDir();
try {
  const body = arg('body') || await fittedBody(tmp);
  const asset = await loadRiggedAsset(body);
  const tgt = await loadSkeletonRestFromFile(body);

  /** minimum world Y over every vertex, for one set of per-joint locals */
  const floorOf = (local: (i: number) => Float32Array): number => {
    const worlds = new Float32Array(asset.jointCount * 16);
    for (let i = 0; i < asset.jointCount; i++) {
      const p = asset.jointParents[i]!;
      const l = local(i);
      if (p < 0) worlds.set(l, i * 16);
      else {
        mul(
          worlds.subarray(p * 16, p * 16 + 16) as Float32Array,
          l,
          worlds.subarray(i * 16, i * 16 + 16) as Float32Array,
        );
      }
    }
    const skinned = skinAll(asset, skinMatrices(worlds, asset.inverseBind, asset.jointCount));
    let mn = Infinity;
    for (let v = 0; v < asset.vertexCount; v++) mn = Math.min(mn, skinned[v * 3 + 1]!);
    return mn;
  };

  say(`# skinned-mesh floor — ${body.split(/[\\/]/).at(-1)}`);
  const bind = floorOf((i) => asset.bindLocals.subarray(i * 16, i * 16 + 16) as Float32Array);
  say(`  bind pose: minY ${bind.toFixed(4)} m = ${(bind * PPM).toFixed(2)} px at ppm ${PPM}`);
  say('');
  say('  clip            footContactMaxErrM     mesh minY        px      verdict');

  let worstClip = '';
  let worst = Infinity;
  for (const clipId of CLIPS) {
    const path = `${PACK}/clips/${clipId}.glb`;
    const doc = await new NodeIO().read(path);
    const src = await loadSkeletonRestFromFile(path);
    const clip = loadClip(doc, doc.getRoot().listAnimations()[0]!.getName(), clipId);
    const r = retargetClip(clip, src, tgt, UAL_HUMANOID);
    const poses = sampleClip(r.clip, tgt, { frames: 8, speed: 1, holdLast: false });
    const idx = new Map(poses.jointNames.map((n, i) => [n, i]));
    let mn = Infinity;
    for (let f = 0; f < poses.frames; f++) {
      mn = Math.min(
        mn,
        floorOf((i) => {
          const j = idx.get(asset.jointNames[i]!);
          if (j === undefined) {
            return asset.bindLocals.subarray(i * 16, i * 16 + 16) as Float32Array;
          }
          const o = (f * poses.jointNames.length + j) * 16;
          return poses.data.subarray(o, o + 16) as Float32Array;
        }),
      );
    }
    if (mn < worst) {
      worst = mn;
      worstClip = clipId;
    }
    say(
      `  ${clipId.padEnd(15)} ${r.stats.footContactMaxErrM.toFixed(5).padStart(10)}     ` +
        `${mn.toFixed(4).padStart(9)} m ${(mn * PPM).toFixed(2).padStart(7)}    ` +
        `${mn >= 0 ? 'on or above the floor' : 'BELOW the floor'}`,
    );
  }

  say('');
  say(
    `  worst: ${worstClip} at ${worst.toFixed(4)} m = ${(worst * PPM).toFixed(2)} px below Y=0`,
  );
  if (worst >= -0.005) {
    say('  The retarget keeps the mesh on the floor. Any `bottom` clipping is NOT a sink.');
  } else {
    say(
      `  Real penetration. Note WHICH clips: a death animation compressing into the ground\n` +
        '  is the animation doing its job, not a retarget fault, and correcting it would make\n' +
        '  a body lying down hover.',
    );
  }
} finally {
  await Deno.writeTextFile(
    `${REPO}docs/internal/proofs/meshfloor.md`,
    '# Skinned-mesh floor (P4-T3 follow-up)\n\nCaptured by `tools/proofs/meshfloor.ts`; ' +
      'regenerate rather than hand-editing.\n\n```\n' + lines.join('\n') + '\n```\n',
  );
  console.log('\nrecorded to docs/internal/proofs/meshfloor.md');
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
}
