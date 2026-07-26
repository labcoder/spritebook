/**
 * Strict structural parser for the .tres subset godot.ts emits — the
 * everywhere-test for Godot correctness (a real-engine import smoke is
 * deferred to end-of-project by maintainer decision). parseTres accepts
 * EXACTLY the emitted grammar and throws a precise, line-numbered error on
 * anything else: unknown sections, malformed lines, duplicate or dangling
 * ids, non-finite numbers, CRLF, or a missing trailing newline.
 *
 * validateTres then checks a parsed file AGAINST a BakeManifest. It derives
 * the canonical frame order and (clipId, direction) grouping independently of
 * the emitter, so an ordering bug in godot.ts cannot cancel itself out here.
 */
import type { BakeManifest } from '@spritebook/schema';
import { atlasPageName } from '../pack/contracts.ts';

export interface TresRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TresExtResource {
  type: string;
  path: string;
  id: string;
}

export interface TresSubResource {
  id: string;
  /** ext_resource id referenced by `atlas = ExtResource("...")` */
  atlasExtId: string;
  region: TresRect;
  /** transparent pad that re-centres the texture on the frame's pivot */
  margin: TresRect;
}

export interface TresAnimationFrame {
  duration: number;
  /** sub_resource id referenced by `"texture": SubResource("...")` */
  texture: string;
}

export interface TresAnimation {
  name: string;
  loop: boolean;
  speed: number;
  frames: TresAnimationFrame[];
}

export interface TresFile {
  header: { type: string; loadSteps: number; format: number };
  extResources: TresExtResource[];
  subResources: TresSubResource[];
  animations: TresAnimation[];
}

/** Thrown by parseTres — message carries the 1-based line number. */
export class TresParseError extends Error {
  override name = 'TresParseError';
}

/** Thrown by validateTres — message names the first manifest mismatch. */
export class TresValidateError extends Error {
  override name = 'TresValidateError';
}

const HEADER_RE = /^\[gd_resource type="(SpriteFrames)" load_steps=(\d+) format=(3)\]$/;
const EXT_RE = /^\[ext_resource type="(Texture2D)" path="([^"]+)" id="([^"]+)"\]$/;
const SUB_RE = /^\[sub_resource type="AtlasTexture" id="([^"]+)"\]$/;
const ATLAS_RE = /^atlas = ExtResource\("([^"]+)"\)$/;
const REGION_RE = /^region = Rect2\(([^\s,()]+), ([^\s,()]+), ([^\s,()]+), ([^\s,()]+)\)$/;
const MARGIN_RE = /^margin = Rect2\(([^\s,()]+), ([^\s,()]+), ([^\s,()]+), ([^\s,()]+)\)$/;
const DURATION_RE = /^"duration": ([^\s,]+),$/;
const TEXTURE_RE = /^"texture": SubResource\("([^"]+)"\)$/;
const LOOP_RE = /^"loop": (true|false),$/;
const NAME_RE = /^"name": &"([^"]+)",$/;
const SPEED_RE = /^"speed": ([^\s,]+)$/;

function fail(line: number, msg: string): never {
  throw new TresParseError(`.tres line ${line}: ${msg}`);
}

/** Parse the exact .tres subset godot.ts emits; throw TresParseError otherwise. */
export function parseTres(text: string): TresFile {
  if (text.includes('\r')) {
    throw new TresParseError('.tres must use LF line endings (CR found)');
  }
  if (!text.endsWith('\n')) {
    throw new TresParseError('.tres must end with a trailing newline');
  }
  const lines = text.slice(0, -1).split('\n');
  let i = 0;
  const peek = (): string | undefined => (i < lines.length ? lines[i] : undefined);
  const take = (): [string, number] => {
    if (i >= lines.length) fail(lines.length + 1, 'unexpected end of file');
    const pair: [string, number] = [lines[i], i + 1];
    i++;
    return pair;
  };
  const expectBlank = (): void => {
    const [l, n] = take();
    if (l !== '') fail(n, `expected a blank line, got '${l}'`);
  };
  const finiteNum = (raw: string, n: number, what: string): number => {
    const v = Number(raw);
    if (!Number.isFinite(v)) fail(n, `${what} not finite: '${raw}'`);
    return v;
  };

  // header
  const [headerLine, headerNo] = take();
  const hm = HEADER_RE.exec(headerLine);
  if (hm === null) fail(headerNo, `malformed gd_resource header: '${headerLine}'`);
  const header = { type: hm[1], loadSteps: Number(hm[2]), format: Number(hm[3]) };
  expectBlank();

  // ext_resources (one per line, consecutive)
  const extResources: TresExtResource[] = [];
  const extIds = new Set<string>();
  while (peek()?.startsWith('[ext_resource') ?? false) {
    const [l, n] = take();
    const m = EXT_RE.exec(l);
    if (m === null) fail(n, `malformed ext_resource: '${l}'`);
    if (extIds.has(m[3])) fail(n, `duplicate ext_resource id "${m[3]}"`);
    extIds.add(m[3]);
    extResources.push({ type: m[1], path: m[2], id: m[3] });
  }
  if (extResources.length === 0) {
    fail(i + 1, `expected at least one ext_resource, got '${peek() ?? '<eof>'}'`);
  }
  expectBlank();

  // sub_resource blocks (header + atlas + region, blank-terminated)
  const subResources: TresSubResource[] = [];
  const subIds = new Set<string>();
  while (peek()?.startsWith('[sub_resource') ?? false) {
    const [sl, sn] = take();
    const sm = SUB_RE.exec(sl);
    if (sm === null) fail(sn, `malformed sub_resource header: '${sl}'`);
    if (subIds.has(sm[1])) fail(sn, `duplicate sub_resource id "${sm[1]}"`);
    subIds.add(sm[1]);
    const [al, an] = take();
    const am = ATLAS_RE.exec(al);
    if (am === null) fail(an, `malformed atlas line: '${al}'`);
    if (!extIds.has(am[1])) {
      fail(an, `sub_resource "${sm[1]}" references unknown ext_resource "${am[1]}"`);
    }
    const [rl, rn] = take();
    const rm = REGION_RE.exec(rl);
    if (rm === null) fail(rn, `malformed region line: '${rl}'`);
    const nums = rm.slice(1, 5).map((raw) => {
      const v = finiteNum(raw, rn, 'region number');
      if (!Number.isInteger(v)) fail(rn, `region number not an integer: '${raw}'`);
      return v;
    });
    // margin carries the pivot (godot.ts pivotMargin) — fractional pivots make
    // fractional margins, so unlike region it is NOT constrained to integers
    const [ml, mn] = take();
    const mm = MARGIN_RE.exec(ml);
    if (mm === null) fail(mn, `malformed margin line: '${ml}'`);
    const mnums = mm.slice(1, 5).map((raw) => finiteNum(raw, mn, 'margin number'));
    subResources.push({
      id: sm[1],
      atlasExtId: am[1],
      region: { x: nums[0], y: nums[1], w: nums[2], h: nums[3] },
      margin: { x: mnums[0], y: mnums[1], w: mnums[2], h: mnums[3] },
    });
    expectBlank();
  }
  {
    const [l, n] = take();
    if (l !== '[resource]') {
      if (l.startsWith('[')) fail(n, `unknown section: '${l}'`);
      fail(n, `expected [resource], got '${l}'`);
    }
    if (subResources.length === 0) fail(n, 'expected at least one sub_resource before [resource]');
  }

  // animations array
  {
    const [l, n] = take();
    if (l !== 'animations = [{') fail(n, `expected 'animations = [{', got '${l}'`);
  }
  const animations: TresAnimation[] = [];
  const animNames = new Set<string>();
  let moreAnimations = true;
  while (moreAnimations) {
    const frames: TresAnimationFrame[] = [];
    {
      const [l, n] = take();
      if (l !== '"frames": [{') fail(n, `expected '"frames": [{', got '${l}'`);
    }
    let moreFrames = true;
    while (moreFrames) {
      const [dl, dn] = take();
      const dm = DURATION_RE.exec(dl);
      if (dm === null) fail(dn, `malformed duration line: '${dl}'`);
      const duration = finiteNum(dm[1], dn, 'duration');
      const [tl, tn] = take();
      const tm = TEXTURE_RE.exec(tl);
      if (tm === null) fail(tn, `malformed texture line: '${tl}'`);
      if (!subIds.has(tm[1])) {
        fail(tn, `animation frame references unknown sub_resource "${tm[1]}"`);
      }
      frames.push({ duration, texture: tm[1] });
      const [el, en] = take();
      if (el === '}],') moreFrames = false;
      else if (el !== '}, {') fail(en, `expected '}, {' or '}],', got '${el}'`);
    }
    const [ll, ln] = take();
    const lm = LOOP_RE.exec(ll);
    if (lm === null) fail(ln, `malformed loop line: '${ll}'`);
    const [nl, nn] = take();
    const nm = NAME_RE.exec(nl);
    if (nm === null) fail(nn, `malformed name line: '${nl}'`);
    if (animNames.has(nm[1])) fail(nn, `duplicate animation name "${nm[1]}"`);
    animNames.add(nm[1]);
    const [spl, spn] = take();
    const spm = SPEED_RE.exec(spl);
    if (spm === null) fail(spn, `malformed speed line: '${spl}'`);
    animations.push({
      name: nm[1],
      loop: lm[1] === 'true',
      speed: finiteNum(spm[1], spn, 'speed'),
      frames,
    });
    const [el, en] = take();
    if (el === '}]') moreAnimations = false;
    else if (el !== '}, {') fail(en, `expected '}, {' or '}]', got '${el}'`);
  }
  if (i !== lines.length) fail(i + 1, `unexpected content after animations: '${lines[i]}'`);

  return { header, extResources, subResources, animations };
}

/**
 * Check a parsed .tres against the manifest it claims to project:
 * load_steps arithmetic, ext_resources <-> lit pages, deterministic ids,
 * every region == its frame's atlas rect, every frame ANCHORED on its recorded
 * pivot, and one animation per (clipId, direction) with matching names, frame
 * counts, refs, and per-clip loop/speed.
 */
export function validateTres(parsed: TresFile, manifest: BakeManifest): void {
  const err = (msg: string): never => {
    throw new TresValidateError(`validateTres: ${msg}`);
  };

  const extCount = parsed.extResources.length;
  const subCount = parsed.subResources.length;
  const wantSteps = extCount + subCount + 1;
  if (parsed.header.loadSteps !== wantSteps) {
    err(`load_steps=${parsed.header.loadSteps} != ext(${extCount}) + sub(${subCount}) + 1`);
  }

  // ext_resources: exactly the lit pages, in page order, ids "1","2",...
  const litPages = manifest.atlases
    .filter((p) => p.pass === 'lit')
    .sort((a, b) => a.pageIndex - b.pageIndex);
  if (extCount !== litPages.length) {
    err(`ext_resource count ${extCount} != lit page count ${litPages.length}`);
  }
  for (const [idx, page] of litPages.entries()) {
    const ext = parsed.extResources[idx];
    const wantPath = atlasPageName('lit', page.pageIndex);
    if (ext.path !== wantPath) err(`ext_resource[${idx}] path '${ext.path}' != '${wantPath}'`);
    if (ext.id !== String(idx + 1)) err(`ext_resource[${idx}] id '${ext.id}' != '${idx + 1}'`);
  }
  const extPathById = new Map(parsed.extResources.map((e) => [e.id, e.path]));

  // canonical frame order, derived here independently of the emitter
  const frames = [...manifest.frames].sort((a, b) => {
    if (a.clipId !== b.clipId) return a.clipId < b.clipId ? -1 : 1;
    return a.direction - b.direction || a.frame - b.frame;
  });
  if (subCount !== frames.length) {
    err(`sub_resource count ${subCount} != manifest frame count ${frames.length}`);
  }
  for (const [idx, f] of frames.entries()) {
    const sub = parsed.subResources[idx];
    if (sub.id !== `AtlasTexture_${idx + 1}`) {
      err(`sub_resource[${idx}] id '${sub.id}' != 'AtlasTexture_${idx + 1}'`);
    }
    const r = sub.region;
    const a = f.atlas;
    if (r.x !== a.x || r.y !== a.y || r.w !== a.w || r.h !== a.h) {
      err(
        `${sub.id} region (${r.x}, ${r.y}, ${r.w}, ${r.h}) != frame ` +
          `${f.clipId}/d${f.direction}/f${f.frame} rect (${a.x}, ${a.y}, ${a.w}, ${a.h})`,
      );
    }
    const page = extPathById.get(sub.atlasExtId);
    const wantPage = atlasPageName('lit', a.pageIndex);
    if (page !== wantPage) {
      err(`${sub.id} references page '${page}' != frame's lit page '${wantPage}'`);
    }
    // THE ANCHOR. Godot draws an AtlasTexture at `region.size + margin.size`
    // with the region `margin.position` inside it, and AnimatedSprite2D centres
    // that box on the node origin (`centered` defaults to true) — so the origin
    // sits at this cell-local pixel. It must be the pivot the bake recorded, or
    // every frame draws off its own feet.
    const m = sub.margin;
    if (m.x < 0 || m.y < 0 || m.x > m.w || m.y > m.h) {
      err(
        `${sub.id} margin (${m.x}, ${m.y}, ${m.w}, ${m.h}) puts the region outside its own ` +
          'texture box (0 <= position <= size per axis), so Godot would clip the frame',
      );
    }
    const anchor = { x: (r.w + m.w) / 2 - m.x, y: (r.h + m.h) / 2 - m.y };
    // exact for integer pivots (every real bake); the slack only absorbs ULP
    // drift in the float arithmetic a fractional pivot would introduce
    if (Math.abs(anchor.x - f.pivotPx.x) > 1e-6 || Math.abs(anchor.y - f.pivotPx.y) > 1e-6) {
      err(
        `${sub.id} anchors at (${anchor.x}, ${anchor.y}) but frame ` +
          `${f.clipId}/d${f.direction}/f${f.frame} recorded pivot ` +
          `(${f.pivotPx.x}, ${f.pivotPx.y})`,
      );
    }
  }

  // animations: one per (clipId, direction), in group order
  const groups: Array<{ clipId: string; direction: number; subIndices: number[] }> = [];
  for (const [idx, f] of frames.entries()) {
    const last = groups.at(-1);
    if (last !== undefined && last.clipId === f.clipId && last.direction === f.direction) {
      last.subIndices.push(idx);
    } else {
      groups.push({ clipId: f.clipId, direction: f.direction, subIndices: [idx] });
    }
  }
  if (parsed.animations.length !== groups.length) {
    err(
      `animation count ${parsed.animations.length} != clip-direction group count ${groups.length}`,
    );
  }
  // per-clip timing, when the bake recorded it (`clips` is optional)
  const timingByClip = new Map((manifest.clips ?? []).map((c) => [c.clipId, c]));

  for (const [gi, g] of groups.entries()) {
    const anim = parsed.animations[gi];
    const wantName = `${g.clipId}_d${String(g.direction).padStart(2, '0')}`;
    if (anim.name !== wantName) err(`animation[${gi}] name '${anim.name}' != '${wantName}'`);
    const timing = timingByClip.get(g.clipId);
    // THE MANIFEST decides whether a clip loops. This used to demand `loop ===
    // true` of every animation, which made a death clip's endless restart the
    // spec instead of the bug. Absent timing keeps the documented fallback.
    const wantLoop = timing?.loop ?? true;
    if (anim.loop !== wantLoop) {
      err(`animation '${anim.name}' loop=${anim.loop}, but the manifest says ${wantLoop}`);
    }
    if (timing !== undefined && anim.speed !== timing.fps) {
      err(`animation '${anim.name}' speed ${anim.speed} != clip '${g.clipId}' fps ${timing.fps}`);
    }
    if (!(anim.speed > 0)) err(`animation '${anim.name}' speed ${anim.speed} must be > 0`);
    if (anim.frames.length !== g.subIndices.length) {
      err(
        `animation '${anim.name}' has ${anim.frames.length} frames, ` +
          `manifest group has ${g.subIndices.length}`,
      );
    }
    for (const [j, subIndex] of g.subIndices.entries()) {
      const frame = anim.frames[j];
      if (frame.texture !== `AtlasTexture_${subIndex + 1}`) {
        err(
          `animation '${anim.name}' frame ${j} references '${frame.texture}' ` +
            `!= 'AtlasTexture_${subIndex + 1}'`,
        );
      }
      if (frame.duration !== 1) {
        err(`animation '${anim.name}' frame ${j} duration ${frame.duration} != 1`);
      }
    }
  }
}
