import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * How big does a cell have to be for a REAL clip set?
 *
 * The 100-character pivot raised `silhouette-clipped` on every character, and
 * the flag decomposed its own cause: some of it is the fitted body sitting
 * under the ground plane, the rest is the character genuinely outgrowing the
 * cell. Both remedies are plausible and they are not the same fix, so this
 * measures which is which before anything moves.
 *
 * Method: bake ONE character at an oversized cell at the SAME world scale, so
 * nothing clips and every silhouette is fully present, then read each frame's
 * alpha bounding box out of the atlas and express it relative to that frame's
 * recorded pivot. That gives four numbers per frame in pixels-at-this-ppm:
 *
 *   above   how far the silhouette reaches above the pivot  -> cell height need
 *   below   how far it reaches BELOW the pivot              -> under the floor
 *   left    how far left of the pivot                       -> cell width need
 *   right   how far right                                   -> cell width need
 *
 * `below` is the GROUND BAND, not burial (D-034). At elevation the pivot pins
 * world Y=0 at ONE point — the bounds centre — so a contact point d metres
 * nearer the camera lands d·sin(el)·ppm pixels lower. The column is measuring
 * that correctly; an earlier caveat here called it untrustworthy and was wrong.
 * Cross-check against `tools/proofs/meshfloor.ts`, which measures the geometry:
 * `below` large with meshfloor ≥ 0 is foreshortening, `below` large with
 * meshfloor < 0 is a genuinely ungrounded mesh.
 *
 * Run: DENO_WEBGPU_BACKEND=vulkan deno run --allow-all tools/proofs/framing.ts
 */
// the exact pin packages/pack and packages/cli carry; tools/ is not a
// workspace member, so the specifier is spelled out rather than mapped
import { decode as decodePng } from 'fast-png';
import { runCli } from '../../packages/cli/dist/mod.js';
import { BakeManifestSchema, type FrameRecord, parseWith } from '../../packages/schema/dist/mod.js';

const REPO = new URL('../../', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const IMAGE = `${REPO}tests/fixtures/bulma-front.png`;
const BODY = `${REPO}packages/rig/bodies/ubc-male`;

/** The same clip set the roster proof uses — the thing that actually clipped. */
const CLIPS = 'idle-loop:8,walk-loop:8,jog-fwd-loop:8,sprint-loop:6,punch-jab:6,death01:10';
/** Oversized on purpose: at ppm 32 a 1.8 m character is ~58 px, so 256 is slack. */
const BIG_CELL = '256x256';
const PPM = '32';

const lines: string[] = [];
const say = (s: string) => {
  console.log(s);
  lines.push(s);
};

function io() {
  const out: string[] = [];
  return {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => out.push(s),
    out,
  };
}
async function cli(args: string[], label: string): Promise<void> {
  const o = io();
  const code = await runCli(args, o);
  if (code !== 0) {
    throw new Error(`${label} exited ${code}:\n${o.out.slice(-10).join('\n')}`);
  }
}

interface Extent {
  above: number;
  below: number;
  left: number;
  right: number;
}

/** Alpha bounding box of one frame's rect, relative to its pivot. */
function extentOf(
  rgba: Uint8Array,
  pageW: number,
  f: FrameRecord,
): Extent | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let y = 0; y < f.atlas.h; y++) {
    for (let x = 0; x < f.atlas.w; x++) {
      const px = (f.atlas.y + y) * pageW + (f.atlas.x + x);
      if (rgba[px * 4 + 3]! === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null; // an entirely transparent frame
  // pivotPx is in cell space with y growing DOWN, same as the raster
  return {
    above: f.pivotPx.y - minY,
    below: maxY - f.pivotPx.y,
    left: f.pivotPx.x - minX,
    right: maxX - f.pivotPx.x,
  };
}

const tmp = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
const ws = `${tmp}/framing`;
try {
  say('# How big does a cell have to be for a real clip set?');
  say(
    `  measured at ppm ${PPM} in a ${BIG_CELL} cell (oversized so nothing clips)`,
  );
  say(`  clips: ${CLIPS}`);

  await cli(
    [
      'gen',
      '--workspace',
      ws,
      '--character',
      'framing',
      '--image',
      IMAGE,
      '--model',
      'fixture-gen',
    ],
    'gen',
  );
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
  await cli(
    [
      'bake',
      '--workspace',
      ws,
      '--cell',
      BIG_CELL,
      '--ppm',
      PPM,
      '--padding',
      '6',
    ],
    'bake',
  );

  const manifestPath = `${ws}/character.json`;
  const character = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const bakeDir = `${ws}/bakes/bake-${character.lastBakeId}`;
  const bake = parseWith(
    BakeManifestSchema,
    JSON.parse(await fs.readFile(`${bakeDir}/manifest.json`, 'utf8')),
    'BakeManifest',
  );
  say(`  ${bake.frames.length} frames, ${bake.atlases.length} atlas pages`);
  if (bake.flags.length > 0) {
    say(
      `  WARNING: the oversized bake still flagged: ${bake.flags.map((f) => f.code).join(', ')}`,
    );
  } else {
    say(
      '  the oversized bake raised no flags, so every silhouette is fully present',
    );
  }

  // decode each LIT page once; frames index into them by rect
  const pages = new Map<number, { data: Uint8Array; width: number }>();
  for (const page of bake.atlases.filter((a) => a.pass === 'lit')) {
    const png = decodePng(
      new Uint8Array(await fs.readFile(`${bakeDir}/${page.png}`)),
    );
    pages.set(page.pageIndex, {
      data: new Uint8Array(png.data as unknown as ArrayLike<number>),
      width: png.width,
    });
  }

  const perClip = new Map<string, Extent[]>();
  for (const f of bake.frames) {
    const page = pages.get(f.atlas.pageIndex);
    if (!page) continue;
    const e = extentOf(page.data, page.width, f);
    if (!e) continue;
    const list = perClip.get(f.clipId) ?? [];
    list.push(e);
    perClip.set(f.clipId, list);
  }

  const worst = (list: Extent[], k: keyof Extent) => Math.max(...list.map((e) => e[k]));
  say('\n## per clip, worst frame in each direction (px at this ppm)');
  say('  clip                 above  below   left  right');
  const all: Extent[] = [];
  for (const [clipId, list] of [...perClip].sort()) {
    all.push(...list);
    say(
      `  ${clipId.padEnd(18)} ${String(worst(list, 'above')).padStart(6)} ` +
        `${String(worst(list, 'below')).padStart(6)} ${String(worst(list, 'left')).padStart(6)} ` +
        `${String(worst(list, 'right')).padStart(6)}`,
    );
  }
  const above = worst(all, 'above');
  const below = worst(all, 'below');
  const left = worst(all, 'left');
  const right = worst(all, 'right');
  say(
    `  ${'WORST OVERALL'.padEnd(18)} ${String(above).padStart(6)} ${String(below).padStart(6)} ` +
      `${String(left).padStart(6)} ${String(right).padStart(6)}`,
  );

  // ------------------------------------------------------------- the verdict
  const { STANDARD_30 } = await import('../../packages/core/dist/presets.js');
  const pad = STANDARD_30.paddingPx;
  const idle = perClip.get('idle-loop') ?? [];
  say('\n## what this means for the default preset');
  say(
    `  an IDLE-only bake needs ${worst(idle, 'left') + worst(idle, 'right') + 2 * pad} x ` +
      `${worst(idle, 'above') + worst(idle, 'below') + 2 * pad} px ` +
      `(w x h, padding ${pad} each side)`,
  );
  say(
    `  the CLIP SET needs      ${left + right + 2 * pad} x ${above + below + 2 * pad} px`,
  );
  say(
    `  the shipped default is  ${STANDARD_30.cellPx.w} x ${STANDARD_30.cellPx.h} px ` +
      `with ${pad} px padding (D-032 moved the cell off 64 on exactly this ` +
      `measurement; D-035 moved the padding, and the cell again with it)`,
  );
  say('');
  if (below > pad) {
    say(
      `  BELOW the pivot: ${below} px of silhouette sits under world Y=0. With a feet-baseline\n` +
        `  pivot the pivot row IS the ground plane, so this is the body standing IN the floor —\n` +
        `  a GROUNDING fault. No cell size fixes it; the mesh has to be sat on Y=0.`,
    );
  } else {
    say(
      `  BELOW the pivot: ${below} px of GROUND BAND, inside the ${pad} px padding ` +
        `(${pad - 1} rows available) — nothing is buried and nothing is cut.`,
    );
  }
  const widthNeed = left + right + 2 * pad;
  if (widthNeed > STANDARD_30.cellPx.w) {
    say(
      `\n  WIDTH: the clip set reaches ${left} px left and ${right} px right of the pivot, so it\n` +
        `  needs ${widthNeed} px of cell against the default's ${STANDARD_30.cellPx.w}. ` +
        `That is real overflow: a cell/ppm decision, not a grounding one.`,
    );
  } else {
    say(
      `
  WIDTH: ${widthNeed} px needed (silhouette ${left + right} + padding ${2 * pad}), ` +
        `which the default ${STANDARD_30.cellPx.w} px cell holds.`,
    );
  }
} finally {
  await fs.writeFile(
    `${REPO}docs/internal/proofs/framing.md`,
    '# Cell sizing for a real clip set (P4-T3 follow-up)\n\nCaptured by ' +
      '`tools/proofs/framing.ts`; regenerate rather than hand-editing.\n\n```\n' +
      lines.join('\n') + '\n```\n',
  );
  console.log('\nrecorded to docs/internal/proofs/framing.md');
  await fs.rm(tmp, { recursive: true }).catch(() => {});
}
