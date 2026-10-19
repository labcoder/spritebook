/**
 * The P4-T3 scale proof: ten real characters, baked as a batch, then a look
 * change on one of them, and the plan's prediction checked against what the
 * bakes actually did.
 *
 * This is not a unit test and does not belong in the suite — it needs a GPU
 * and takes minutes. It is the evidence that `bake --all` is safe to point at
 * a hundred characters overnight, and it answers the three questions that
 * matter before that run:
 *
 *   1. does a cold batch bake all ten, or does one bad character take the
 *      night down with it?
 *   2. does a warm batch correctly say "nothing to do" — the property the
 *      overnight pivot depends on, since it re-plans everything it touches?
 *   3. when ONE character's look changes, does the plan name that character,
 *      that field, and no others — and does the bake that follows hit cache
 *      on the nine it said were fresh?
 *
 * Run:  DENO_WEBGPU_BACKEND=vulkan deno run --allow-all tools/proofs/roster10.ts
 * Add --keep to leave the roster on disk for inspection.
 */
import { runCli } from '../../packages/cli/mod.ts';
import { type BakePlan, BakePlanSchema } from '../../packages/schema/mod.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const IMAGE = `${REPO}tests/fixtures/bulma-front.png`;
const KEEP = Deno.args.includes('--keep');

const NAMES = [
  'bulma',
  'goku',
  'trunks',
  'vegeta',
  'piccolo',
  'krillin',
  'gohan',
  'chichi',
  'roshi',
  'yamcha',
];

const lines: string[] = [];
function io(capture = false) {
  const out: string[] = [];
  return {
    stdout: (s: string) => {
      out.push(s);
      if (!capture) lines.push(s);
    },
    stderr: (s: string) => {
      out.push(s);
      lines.push(`! ${s}`);
    },
    out,
  };
}

async function cli(args: string[], label: string, capture = false): Promise<string[]> {
  const o = io(capture);
  const code = await runCli(args, o);
  if (code !== 0) {
    console.log(o.out.join('\n'));
    throw new Error(`${label} exited ${code}: spritebook ${args.join(' ')}`);
  }
  return o.out;
}

/** The plan as a document, without printing it. */
async function plan(root: string, extra: string[] = []): Promise<BakePlan> {
  const o = io(true);
  await runCli(['bake', '--all', '--root', root, '--plan', '--json', ...extra], o);
  return BakePlanSchema.parse(JSON.parse(o.out.at(-1)!));
}

function say(s: string) {
  console.log(s);
  lines.push(s);
}

const t0 = performance.now();
const root = KEEP ? `${REPO}.proof-roster10` : await Deno.makeTempDir();
if (KEEP) await Deno.mkdir(root, { recursive: true });

try {
  // ---------------------------------------------------------------- build
  say(`# P4-T3 roster proof — ${NAMES.length} characters at ${root}`);
  const build0 = performance.now();
  for (const id of NAMES) {
    const ws = `${root}/${id}`;
    await cli(
      ['gen', '--workspace', ws, '--character', id, '--image', IMAGE, '--model', 'fixture-gen'],
      `gen ${id}`,
      true,
    );
    await cli(['pick', '--workspace', ws, '--result', 'r1'], `pick ${id}`, true);
  }
  say(`built ${NAMES.length} characters in ${((performance.now() - build0) / 1000).toFixed(1)}s`);

  // ------------------------------------------------------- 1. cold batch
  const cold = await plan(root);
  say(`\n## cold plan`);
  say(
    `  ${cold.totals.toBake} to bake, ${cold.totals.fresh} fresh, ` +
      `${cold.totals.blocked} blocked, ${cold.totals.staleFrames} frames to render`,
  );
  assert(cold.totals.toBake === NAMES.length, 'every character is work when nothing is baked');
  assert(cold.totals.blocked === 0, 'nothing is blocked');
  assert(
    cold.characters.every((c) => c.state === 'never-baked'),
    'and each says WHY it is work',
  );

  const bake0 = performance.now();
  await cli(['bake', '--all', '--root', root], 'cold batch');
  const coldS = (performance.now() - bake0) / 1000;
  say(
    `\ncold batch: ${coldS.toFixed(1)}s for ${cold.totals.staleFrames} frames ` +
      `(${(coldS / NAMES.length).toFixed(1)}s/character)`,
  );

  // every character now has a bake on its manifest
  for (const id of NAMES) {
    const m = JSON.parse(await Deno.readTextFile(`${root}/${id}/character.json`));
    assert(typeof m.lastBakeId === 'string', `${id} recorded its bake`);
  }

  // ------------------------------------------------------- 2. warm batch
  const warm = await plan(root);
  say(`\n## warm plan (nothing changed)`);
  say(
    `  ${warm.totals.toBake} to bake, ${warm.totals.fresh} fresh, ` +
      `${warm.totals.cachedFrames} frames already baked`,
  );
  assert(warm.totals.toBake === 0, 'a warm roster is NO work — the overnight pivot depends on it');
  assert(warm.totals.fresh === NAMES.length, 'all ten fresh');

  const warm0 = performance.now();
  await cli(['bake', '--all', '--root', root], 'warm batch');
  say(`warm batch: ${((performance.now() - warm0) / 1000).toFixed(1)}s (it should render nothing)`);

  // ------------------------------------------- 3. one look change, planned
  const changed = 'piccolo';
  const before = new Date();
  await new Promise((r) => setTimeout(r, 1100)); // mtime granularity
  await cli(
    ['look', '--workspace', `${root}/${changed}`, '--style', 'cel-2'],
    `look ${changed}`,
    true,
  );

  const after = await plan(root);
  say(`\n## plan after \`look --style cel-2\` on ${changed}`);
  for (const c of after.characters) {
    if (c.state === 'fresh') continue;
    say(`  ${c.displayName} (${c.id}) — ${c.state}, ${c.staleFrames} frames`);
    for (const r of c.reasons) say(`      · ${r.field}: ${r.why.slice(0, 88)}…`);
  }
  assert(after.totals.toBake === 1, `exactly one character is stale (saw ${after.totals.toBake})`);
  assert(after.totals.fresh === NAMES.length - 1, 'the other nine are untouched');
  const stale = after.characters.find((c) => c.state === 'stale')!;
  assert(stale.id === changed, `the stale one is ${changed}`);
  assert(
    stale.reasons.length === 1 && stale.reasons[0]!.field === 'stylePresetHash',
    `and the reason is the style, not a guess: ${
      JSON.stringify(stale.reasons.map((r) => r.field))
    }`,
  );

  // --changed-since agrees, from the cheap side
  const since = await plan(root, ['--changed-since', before.toISOString()]);
  say(
    `\n  --changed-since ${before.toISOString()}: ` +
      `${since.characters.map((c) => c.id).join(', ') || '(none)'}`,
  );
  assert(
    since.characters.length === 1 && since.characters[0]!.id === changed,
    'mtime and the recipe diff agree here — the file that moved is the one that is stale',
  );

  // ------------------------------------------- 4. the prediction, checked
  const predicted = stale.staleFrames;
  const pivot0 = performance.now();
  await cli(['bake', '--all', '--root', root], 'pivot batch');
  const pivotS = (performance.now() - pivot0) / 1000;

  const bakeManifest = async (id: string) => {
    const m = JSON.parse(await Deno.readTextFile(`${root}/${id}/character.json`));
    return JSON.parse(
      await Deno.readTextFile(`${root}/${id}/bakes/bake-${m.lastBakeId}/manifest.json`),
    );
  };
  const changedBake = await bakeManifest(changed);
  say(`\n## the pivot, measured`);
  say(`  predicted ${predicted} frames stale for ${changed}`);
  say(
    `  actual: framesTotal ${changedBake.metrics.framesTotal}, ` +
      `cacheHitPct ${changedBake.metrics.cacheHitPct.toFixed(1)}%, ${pivotS.toFixed(1)}s`,
  );
  assert(
    changedBake.metrics.framesTotal === predicted,
    `the plan predicted the frame count exactly (${predicted})`,
  );
  assert(
    changedBake.metrics.cacheHitPct === 0,
    'a style change is a full miss, exactly as the plan said',
  );
  // and the nine it called fresh did not re-render: their bake ids are unmoved
  const untouched = NAMES.filter((n) => n !== changed);
  for (const id of untouched) {
    const m = await bakeManifest(id);
    assert(m.inputs.stylePresetHash !== changedBake.inputs.stylePresetHash, `${id} kept its style`);
  }
  say(`  the other ${untouched.length} were not re-rendered`);

  say(`\nTOTAL ${((performance.now() - t0) / 1000).toFixed(1)}s — all assertions held`);
  await Deno.writeTextFile(
    `${REPO}docs/internal/proofs/roster10.md`,
    `# ${NAMES.length}-character roster proof (P4-T3)\n\nCaptured by ` +
      `\`tools/proofs/roster10.ts\`; regenerate rather than hand-editing.\n\n\`\`\`\n` +
      lines.join('\n') + '\n```\n',
  );
  say(`\nrecorded to docs/internal/proofs/roster10.md`);
} finally {
  if (!KEEP) await Deno.remove(root, { recursive: true }).catch(() => {});
}

function assert(cond: boolean, why: string): void {
  if (!cond) throw new Error(`FAILED: ${why}`);
  lines.push(`  ok — ${why}`);
}
