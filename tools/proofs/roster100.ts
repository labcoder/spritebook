/**
 * The 100-character pivot at REAL settings (P4-T3 acceptance).
 *
 * The 10-character proof used the shipped defaults — 8 directions of a 6-frame
 * idle stub, 48 cells a character. That is the smallest honest bake and it is
 * not what a roster looks like. This one uses the settings a game actually
 * ships: 8 directions and a real clip set retargeted onto the Track A body, so
 * every character carries hundreds of cells rather than dozens.
 *
 * Track A is the roster path by construction (D-026 rider): one canonical
 * humanoid fitted to each mesh, so the skeleton and the animation bindings are
 * identical across the roster and the clips retarget once. It needs no GPU and
 * no sidecar, which is the only reason building a hundred characters is a
 * thing you can do while waiting for the bakes.
 *
 * What it measures, in order:
 *   build   gen -> pick -> Track A fit -> enable the clip set, per character
 *   cold    `bake --all` over the whole roster
 *   warm    `bake --all` again — must be zero work
 *   pivot   one style change across ALL of them, planned then executed
 *
 * Run:
 *   DENO_WEBGPU_BACKEND=vulkan deno run --allow-all tools/proofs/roster100.ts [--n 100]
 *
 * `--n` scales the roster (the pilot runs at 2 to time one character first).
 * `--keep` leaves it on disk. `--skip-build` reuses an existing --keep roster.
 */
import { runCli } from '../../packages/cli/mod.ts';
import { type BakePlan, BakePlanSchema } from '../../packages/schema/mod.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const IMAGE = `${REPO}spikes/trellis2/refs/bulma-front.png`;
const BODY = `${REPO}packages/rig/bodies/ubc-male`;

const arg = (name: string, fallback: string): string => {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 && Deno.args[i + 1] !== undefined ? Deno.args[i + 1]! : fallback;
};
const N = Number(arg('n', '100'));
const KEEP = Deno.args.includes('--keep');
const SKIP_BUILD = Deno.args.includes('--skip-build');
const ROOT = arg('root', `${REPO}.proof-roster100`);

/**
 * The clip set a character ships with: locomotion, one attack, one death.
 * Frames are per-clip because a 0.43 s sword swing does not need a walk
 * cycle's sampling — this is the same judgement the Anim stage asks a user to
 * make, made once here.
 */
const CLIPS = [
  { id: 'idle-loop', frames: 8 },
  { id: 'walk-loop', frames: 8 },
  { id: 'jog-fwd-loop', frames: 8 },
  { id: 'sprint-loop', frames: 6 },
  { id: 'punch-jab', frames: 6 },
  { id: 'death01', frames: 10 },
];
const DIRECTIONS = 8;
const CELLS_PER_CHARACTER = CLIPS.reduce((n, c) => n + c.frames, 0) * DIRECTIONS;

const lines: string[] = [];
function say(s: string) {
  console.log(s);
  lines.push(s);
}
function io(capture = true) {
  const out: string[] = [];
  return {
    stdout: (s: string) => {
      out.push(s);
      if (!capture) lines.push(s);
    },
    stderr: (s: string) => out.push(s),
    out,
  };
}
async function cli(args: string[], label: string, capture = true): Promise<string[]> {
  const o = io(capture);
  const code = await runCli(args, o);
  if (code !== 0) throw new Error(`${label} exited ${code}:\n${o.out.slice(-12).join('\n')}`);
  return o.out;
}
async function plan(extra: string[] = []): Promise<BakePlan> {
  const o = io(true);
  await runCli(['bake', '--all', '--root', ROOT, '--plan', '--json', ...extra], o);
  return BakePlanSchema.parse(JSON.parse(o.out.at(-1)!));
}
const secs = (from: number) => (performance.now() - from) / 1000;
const pad = (n: number, w = 6) => n.toFixed(1).padStart(w);

const t0 = performance.now();
const id = (i: number) => `hero-${String(i).padStart(3, '0')}`;

say(`# P4-T3 · ${N}-character pivot at real settings`);
say(
  `  ${DIRECTIONS} directions × ${CLIPS.length} clips (${
    CLIPS.map((c) => `${c.id}:${c.frames}`).join(' ')
  })`,
);
say(`  = ${CELLS_PER_CHARACTER} cells/character, ${CELLS_PER_CHARACTER * N} for the roster`);
say(`  root: ${ROOT}`);

try {
  await Deno.mkdir(ROOT, { recursive: true });

  // ------------------------------------------------------------- 1. build
  if (!SKIP_BUILD) {
    const build0 = performance.now();
    const step = { gen: 0, pick: 0, fit: 0, anim: 0 };
    for (let i = 0; i < N; i++) {
      const ws = `${ROOT}/${id(i)}`;
      let t = performance.now();
      await cli(
        [
          'gen',
          '--workspace',
          ws,
          '--character',
          id(i),
          '--image',
          IMAGE,
          '--model',
          'fixture-gen',
        ],
        `gen ${id(i)}`,
      );
      step.gen += secs(t);
      t = performance.now();
      await cli(['pick', '--workspace', ws, '--result', 'r1'], `pick ${id(i)}`);
      step.pick += secs(t);
      t = performance.now();
      // Track A: the canonical body fitted to this mesh. No GPU, no sidecar —
      // and it is what makes the clip set below retarget at all, because the
      // fixture backend emits geometry with no skeleton of its own.
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
      step.fit += secs(t);
      t = performance.now();
      await cli([
        'anim',
        '--enable',
        CLIPS.map((c) => `${c.id}:${c.frames}`).join(','),
        '--workspace',
        ws,
      ], `anim ${id(i)}`);
      step.anim += secs(t);
      if ((i + 1) % 10 === 0 || i === N - 1) {
        say(`  built ${i + 1}/${N} … ${pad(secs(build0))}s`);
      }
    }
    say(
      `\nbuild ${pad(secs(build0))}s total — gen ${pad(step.gen)}s · pick ${pad(step.pick)}s · ` +
        `fit ${pad(step.fit)}s · anim ${pad(step.anim)}s (${(secs(build0) / N).toFixed(2)}s/char)`,
    );
  }

  // -------------------------------------------------------- 2. cold batch
  const cold = await plan();
  say(`\n## cold plan`);
  say(
    `  ${cold.totals.toBake} to bake · ${cold.totals.blocked} blocked · ` +
      `${cold.totals.staleFrames} frames`,
  );
  if (cold.totals.blocked > 0) {
    for (const c of cold.characters.filter((x) => x.state === 'blocked').slice(0, 3)) {
      say(`  BLOCKED ${c.id}: ${c.note}`);
    }
    throw new Error(`${cold.totals.blocked} characters cannot bake — see above`);
  }
  if (cold.totals.staleFrames !== CELLS_PER_CHARACTER * N) {
    say(
      `  NOTE: the plan predicts ${cold.totals.staleFrames} frames, not the ` +
        `${CELLS_PER_CHARACTER * N} this script computed — the plan is the authority`,
    );
  }

  const bake0 = performance.now();
  await cli(['bake', '--all', '--root', ROOT], 'cold batch', false);
  const coldS = secs(bake0);
  say(
    `\ncold batch ${pad(coldS)}s = ${(coldS / 60).toFixed(1)} min · ` +
      `${(coldS / N).toFixed(2)}s/char · ${(cold.totals.staleFrames / coldS).toFixed(1)} frames/s`,
  );

  // -------------------------------------------------------- 3. warm batch
  const warm0 = performance.now();
  const warm = await plan();
  const warmPlanS = secs(warm0);
  say(`\n## warm plan (${pad(warmPlanS)}s to plan ${N} characters)`);
  say(`  ${warm.totals.toBake} to bake · ${warm.totals.fresh} fresh`);
  if (warm.totals.toBake !== 0) {
    for (const c of warm.characters.filter((x) => x.state !== 'fresh').slice(0, 3)) {
      say(`  UNEXPECTED ${c.id} ${c.state}: ${c.reasons.map((r) => r.field).join(',')}`);
    }
    throw new Error('a warm roster must be zero work — the overnight pivot depends on it');
  }
  const warmRun = performance.now();
  await cli(['bake', '--all', '--root', ROOT], 'warm batch');
  say(`warm batch ${pad(secs(warmRun))}s (rendered nothing)`);

  // -------------------------------- 4. THE PIVOT: one style, all characters
  say(`\n## the pivot — \`look --style cel-2\` on all ${N}`);
  const pivotEdit = performance.now();
  for (let i = 0; i < N; i++) {
    await cli(['look', '--workspace', `${ROOT}/${id(i)}`, '--style', 'cel-2'], `look ${id(i)}`);
  }
  say(`  ${N} look changes recorded in ${pad(secs(pivotEdit))}s`);

  const pivotPlan = await plan();
  const stale = pivotPlan.characters.filter((c) => c.state === 'stale');
  say(
    `  plan: ${pivotPlan.totals.toBake} stale · ${pivotPlan.totals.fresh} fresh · ` +
      `${pivotPlan.totals.staleFrames} frames to render`,
  );
  const fields = [...new Set(stale.flatMap((c) => c.reasons.map((r) => r.field)))];
  say(`  every stale character's reason: ${fields.join(', ')}`);
  if (stale.length !== N || fields.length !== 1 || fields[0] !== 'stylePresetHash') {
    throw new Error(
      `the plan must name the style and nothing else: ${stale.length} stale, fields ${fields}`,
    );
  }

  const pivot0 = performance.now();
  await cli(['bake', '--all', '--root', ROOT], 'pivot batch', false);
  const pivotS = secs(pivot0);
  say(
    `\npivot batch ${pad(pivotS)}s = ${(pivotS / 60).toFixed(1)} min · ` +
      `${(pivotPlan.totals.staleFrames / pivotS).toFixed(1)} frames/s`,
  );

  // ------------------------------------------- 5. the morning flag report
  // This is the deliverable of an unattended run: the thing a human reads
  // over coffee to decide what to look at. A count of flags is not that — the
  // flag's own message names which edge clipped and which remedy applies, and
  // dropping it would leave the reader to open a hundred manifests by hand.
  say(`\n## morning report`);
  let framesTotal = 0;
  let flaggedFrames = 0;
  const flagCounts = new Map<string, number>();
  const flagExample = new Map<string, string>();
  const flagged: string[] = [];
  const flicker: { id: string; pct: number }[] = [];
  for (let i = 0; i < N; i++) {
    const m = JSON.parse(await Deno.readTextFile(`${ROOT}/${id(i)}/character.json`));
    const bake = JSON.parse(
      await Deno.readTextFile(`${ROOT}/${id(i)}/bakes/bake-${m.lastBakeId}/manifest.json`),
    );
    framesTotal += bake.metrics.framesTotal;
    flicker.push({ id: id(i), pct: bake.metrics.flickerPct });
    const codes = new Set<string>();
    for (
      const f of bake.flags as { code: string; message: string; frameRefs: unknown[] }[]
    ) {
      codes.add(f.code);
      if (!flagExample.has(f.code)) flagExample.set(f.code, f.message);
      flaggedFrames += f.frameRefs.length;
    }
    for (const c of codes) flagCounts.set(c, (flagCounts.get(c) ?? 0) + 1);
    if (codes.size > 0) flagged.push(id(i));
  }
  flicker.sort((a, b) => b.pct - a.pct);
  const meanFlicker = flicker.reduce((n, f) => n + f.pct, 0) / Math.max(1, flicker.length);
  say(`  ${N} characters · ${framesTotal} frames on disk`);
  say(
    `  flicker: mean ${meanFlicker.toFixed(2)}% · worst ${flicker[0]!.id} ` +
      `${flicker[0]!.pct.toFixed(2)}% · best ${flicker.at(-1)!.pct.toFixed(2)}%`,
  );
  if (flagCounts.size === 0) {
    say('  QA flags: none');
  } else {
    for (const [code, n] of [...flagCounts].sort((a, b) => b[1] - a[1])) {
      say(`\n  QA flag "${code}" on ${n}/${N} characters:`);
      // wrapped, because the remedy is the useful half and a 400-char line in
      // a terminal is a line nobody reads
      const msg = flagExample.get(code)!;
      for (const chunk of msg.match(/.{1,92}(\s|$)/g) ?? [msg]) say(`    ${chunk.trim()}`);
    }
    say(
      `\n  first characters to look at: ${flagged.slice(0, 8).join(', ')}${
        flagged.length > 8 ? ` …and ${flagged.length - 8} more` : ''
      }`,
    );
  }
  say(`\nTOTAL ${pad(secs(t0))}s = ${(secs(t0) / 60).toFixed(1)} min`);
} finally {
  await Deno.writeTextFile(
    `${REPO}docs/internal/proofs/roster100.md`,
    `# ${N}-character pivot at real settings (P4-T3)\n\nCaptured by ` +
      `\`tools/proofs/roster100.ts\`; regenerate rather than hand-editing.\n\n\`\`\`\n` +
      lines.join('\n') + '\n```\n',
  );
  console.log(`\nrecorded to docs/internal/proofs/roster100.md`);
  if (!KEEP) await Deno.remove(ROOT, { recursive: true }).catch(() => {});
}
